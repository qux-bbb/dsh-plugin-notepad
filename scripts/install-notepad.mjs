#!/usr/bin/env node
/**
 * Install (or remove) the notepad plugin in a DeepSeek Harness profile, at one
 * of the two levels the harness composes:
 *
 * - `--scope profile` (default): the plugin lives in `<profile>/plugins/notepad`
 *   and one managed insert row is added to `<profile>/cordis.patch.yml`. Only
 *   that profile gets the plugin. The row's `name` is relative, which the loader
 *   resolves against the profile directory.
 * - `--scope home`: the plugin lives in `$DSH_HOME/plugins/notepad` and one
 *   managed insert row is added to `$DSH_HOME/cordis.patch.yml` — the layer that
 *   applies to every profile. Because that layer is composed under each
 *   profile's base URL, the row's `name` is an absolute `file://` URL.
 *
 * The exact patch region this script owns is fenced by markers, so re-running
 * updates in place, and `--uninstall` removes only what it added. A timestamped
 * backup of the patch file is written before the first change.
 *
 * Usage (the bundled runtime's node works):
 *   node scripts/install-notepad.mjs --profile desktop
 *   node scripts/install-notepad.mjs --scope home
 *   node scripts/install-notepad.mjs --profile desktop --level global --default-scope global
 *   node scripts/install-notepad.mjs --profile desktop --verify
 *   node scripts/install-notepad.mjs --profile desktop --uninstall
 *   node scripts/install-notepad.mjs --profile desktop --dry-run
 */
import { cp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { spawnSync } from 'node:child_process'
import { LEVELS, SCOPES } from '../lib/store.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const SOURCE_DIR = resolve(HERE, '..')
/** The package files copied into a profile; the repo root holds extra dirs (`.dsh`, `node_modules`, `scripts`) that must not travel. */
const PACKAGE_FILES = ['package.json', 'README.md', 'LICENSE', 'cordis.patch.yml', 'lib']
const START_MARKER = '# >>> dsh-plugin-notepad (managed by scripts/install-notepad.mjs) >>>'
const END_MARKER = '# <<< dsh-plugin-notepad <<<'

/** Parse `--flag value`, `--flag=value`, and boolean flags. */
function parseArgs(argv) {
  const options = { scope: 'profile', profile: 'desktop', level: 'both', defaultScope: 'project', dryRun: false, uninstall: false, verify: false, help: false }
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]
    const [flag, inline] = token.includes('=') ? token.split(/=(.*)/s, 2) : [token, undefined]
    const next = () => {
      if (inline !== undefined) return inline
      index += 1
      if (index >= argv.length) throw new Error(`${flag} needs a value`)
      return argv[index]
    }
    switch (flag) {
      case '--scope': options.scope = next(); break
      case '--profile': options.profile = next(); break
      case '--level': options.level = next(); break
      case '--default-scope': options.defaultScope = next(); break
      case '--dsh-home': options.dshHome = next(); break
      case '--dry-run': options.dryRun = true; break
      case '--uninstall': options.uninstall = true; break
      case '--verify': options.verify = true; break
      case '-h': case '--help': options.help = true; break
      default: throw new Error(`unknown argument ${token}`)
    }
  }
  return options
}

const HELP = `Install the notepad plugin into a DSH profile or the harness home.

  --scope profile|home     where to install (default: profile)
  --profile <name>         profile name for --scope profile (default: desktop)
  --level both|global|project
                           note levels the deployment exposes (default: both)
  --default-scope global|project
                           level used when a call omits scope (default: project)
  --dsh-home <path>        harness home; default $DSH_HOME, then ~/.dsh
  --verify                 run the real loader's --dump-config and check the entry
  --uninstall              remove the managed patch region and the copied files
  --dry-run                print the plan without writing
  -h, --help               this help
`

/** Resolve the harness home exactly like `@deepseek-ai/dsh-home-paths`. */
function resolveDshHome(configured) {
  const fromConfig = configured?.trim()
  const fromEnv = process.env.DSH_HOME?.trim()
  return resolve(fromConfig || fromEnv || join(homedir(), '.dsh'))
}

/** The absolute target layout for one install scope. */
function planTargets(options) {
  const dshHome = resolveDshHome(options.dshHome)
  if (options.scope === 'home') {
    return {
      dshHome,
      directory: join(dshHome, 'plugins', 'notepad'),
      patchFile: join(dshHome, 'cordis.patch.yml'),
      label: `$DSH_HOME (${dshHome})`,
    }
  }
  if (options.scope !== 'profile') throw new Error(`unknown --scope ${JSON.stringify(options.scope)}: expected profile or home`)
  const profileDir = join(dshHome, 'profiles', options.profile)
  return {
    dshHome,
    profileDir,
    directory: join(profileDir, 'plugins', 'notepad'),
    patchFile: join(profileDir, 'cordis.patch.yml'),
    label: `profile ${options.profile} (${profileDir})`,
  }
}

/** The managed YAML region: one insert row carrying the plugin config. */
function managedBlock(options, targets) {
  const name = options.scope === 'home'
    ? pathToFileURL(join(targets.directory, 'lib', 'index.js')).href
    : './plugins/notepad/lib/index.js'
  return [
    START_MARKER,
    '- insert:',
    '    - id: notepad',
    `      name: ${name}`,
    '      config:',
    `        level: ${options.level}`,
    `        defaultScope: ${options.defaultScope}`,
    END_MARKER,
  ].join('\n')
}

/**
 * The patch file with the managed region replaced (or removed).
 *
 * Byte-stable across runs: the region is stripped before re-appending, and the
 * result always ends in exactly one newline. User comments and unrelated
 * entries are preserved in every branch.
 */
function rewritePatch(current, block) {
  const remainder = stripManaged(current).replace(/^\s*\n/, '').trimEnd()
  const withoutComments = remainder.replace(/#[^\n]*/g, '').trim()
  if (block === undefined) {
    if (withoutComments === '') return remainder === '' ? '[]\n' : `${remainder}\n\n[]\n`
    return `${remainder}\n`
  }
  const body = withoutComments === '[]' ? remainder.replace(/\[\]/, '').trimEnd() : remainder
  return `${body === '' ? '' : `${body}\n\n`}${block}\n`
}

/** Remove the fenced region, leaving the rest of the user layer untouched. */
function stripManaged(text) {
  const start = text.indexOf(START_MARKER)
  if (start < 0) return text
  const end = text.indexOf(END_MARKER, start)
  if (end < 0) return text.slice(0, start)
  const after = text.slice(end + END_MARKER.length)
  return `${text.slice(0, start)}${after.replace(/^\n/, '')}`
}

/** Copy the package files (never the local tests or dev-only directories). */
async function copyPackage(target) {
  await mkdir(target, { recursive: true })
  await rm(target, { recursive: true, force: true })
  await mkdir(target, { recursive: true })
  for (const name of PACKAGE_FILES) {
    const source = join(SOURCE_DIR, name)
    if (!existsSync(source)) continue
    await cp(source, join(target, name), { recursive: true })
  }
}

/** Run the real loader over the installed profile and assert the entry composes. */
function verifyProfile(options, targets) {
  if (options.scope !== 'profile') {
    console.log('  verification: skipped (the loader CLI rejects only the reserved desktop profile; check with a scratch profile)')
    return true
  }
  if (options.profile === 'desktop') {
    console.log('  verification: skipped — the dsh CLI refuses `desktop`; the running app composes this layer on its own')
    return true
  }
  const bin = join(targets.dshHome, 'profiles', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
  if (!existsSync(bin)) {
    console.log(`  verification: skipped — no dsh launcher at ${bin}`)
    return true
  }
  const result = spawnSync(process.execPath, [bin, '--profile', options.profile, '--dump-config'], { encoding: 'utf8' })
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`
  const composed = output.includes('id: notepad') && output.includes('notepad/lib/index.js')
  console.log(`  verification: ${composed ? 'OK — the real loader composed the notepad entry' : 'FAILED — the entry is missing from the composed tree'}`)
  if (!composed) console.log(output.split('\n').slice(0, 12).map((line) => `    ${line}`).join('\n'))
  return composed
}

async function main() {
  const options = parseArgs(process.argv.slice(2))
  if (options.help) {
    process.stdout.write(HELP)
    return
  }
  if (!LEVELS.includes(options.level)) throw new Error(`--level must be one of ${LEVELS.join(', ')}`)
  if (!SCOPES.includes(options.defaultScope)) throw new Error(`--default-scope must be one of ${SCOPES.join(', ')}`)
  const targets = planTargets(options)
  const block = options.uninstall ? undefined : managedBlock(options, targets)
  const existing = existsSync(targets.patchFile) ? await readFile(targets.patchFile, 'utf8') : '[]\n'
  const next = rewritePatch(existing, block)

  console.log(`${options.uninstall ? 'Uninstall' : 'Install'} notepad → ${targets.label}`)
  console.log(`  package: ${targets.directory}`)
  console.log(`  patch:   ${targets.patchFile}`)
  if (options.dryRun) {
    console.log(`  --- planned patch content ---\n${next.split('\n').map((line) => `  ${line}`).join('\n')}`)
    return
  }

  // Files first, patch last: a watching host (dsh-hmr) reacts to the patch write
  // immediately, and an entry pointing at files that are not on disk yet mounts
  // without a fiber (the loader never retries an unchanged inactive entry).
  if (options.uninstall) {
    await rm(targets.directory, { recursive: true, force: true })
    console.log('  plugin files removed')
  } else {
    await copyPackage(targets.directory)
    console.log(`  ${(await stat(join(targets.directory, 'lib', 'index.js'))).size} bytes of plugin code copied`)
  }

  if (next !== existing) {
    const backup = `${targets.patchFile}.bak-notepad-${new Date().toISOString().replace(/[:.]/g, '-')}`
    await writeFile(backup, existing, 'utf8')
    console.log(`  backup:  ${backup}`)
    await writeFile(targets.patchFile, next, 'utf8')
    console.log('  patch updated')
  } else {
    console.log('  patch already up to date')
  }

  if (options.verify && !options.uninstall) {
    if (!verifyProfile(options, targets)) process.exitCode = 1
  }
  console.log(options.uninstall
    ? '\nDone. The profile composes without the notepad entry after its next reload.'
    : '\nDone. The layer applies on the next reload: the desktop app hot-reloads profile patches (dsh-hmr) when the host provides `profileContext`, otherwise restart the app.'
      + '\nIf the entry still reads `status: "inactive"` afterwards, change one config value once (for example\n`--default-scope global`, then back) or restart: a host never retries an unchanged inactive entry,\nand a declared DSH peer range the host judges incompatible (see the README pitfalls) refuses to mount.')
}

try {
  await main()
} catch (error) {
  console.error(`install-notepad: ${error.message}`)
  process.exitCode = 1
}
