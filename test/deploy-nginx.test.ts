import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, symlinkSync, readlinkSync, rmSync, readdirSync, chmodSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, it } from 'node:test'
import { getLlamaConfig } from '../server/llama-client'

const helper = readFileSync('scripts/sync-production-nginx.sh', 'utf8')
const deployment = readFileSync('scripts/deploy.sh', 'utf8')
const desired = readFileSync('deploy/nginx.conf', 'utf8')
const old = desired.replace('        proxy_read_timeout 900s;\n', '').replace('        proxy_send_timeout 900s;\n', '')

function fixture(run: (files: {
  root: string; target: string; site: string; log: () => string
  invoke: (script?: string, args?: string[], extra?: Record<string, string>) => ReturnType<typeof spawnSync>
}) => void) {
  const root = mkdtempSync(path.join(tmpdir(), 'nfl-nginx-test-'))
  try {
    for (const folder of ['scripts', 'deploy', 'bin', 'backups']) mkdirSync(path.join(root, folder))
    writeFileSync(path.join(root, 'scripts/sync-production-nginx.sh'), helper)
    writeFileSync(path.join(root, 'scripts/deploy.sh'), deployment)
    writeFileSync(path.join(root, 'deploy/nginx.conf'), desired)
    writeFileSync(path.join(root, '.env.local'), 'API_SPORTS_KEY=test-key\n')
    const target = path.join(root, 'installed-site')
    const site = path.join(root, 'enabled-site')
    writeFileSync(target, old)
    symlinkSync(target, site)
    const command = (name: string, text: string) => writeFileSync(path.join(root, 'bin', name), `#!/bin/bash\nset -eu\n${text}\n`, { mode: 0o755 })
    command('id', 'echo "${TEST_UID:-0}"')
    command('nginx', `
echo "nginx $*" >> "$TEST_LOG"
if [[ "\${TEST_VALIDATION_FAILURE:-0}" == 1 ]] && cmp -s "$NGINX_SITE_PATH" "$DEPLOY_PATH/deploy/nginx.conf"; then exit 1; fi
`)
    command('systemctl', `
echo "systemctl $*" >> "$TEST_LOG"
if [[ "\${TEST_RELOAD_FAILURE:-0}" == 1 ]] && cmp -s "$NGINX_SITE_PATH" "$DEPLOY_PATH/deploy/nginx.conf"; then exit 1; fi
if [[ "\${TEST_ROLLBACK_FAILURE:-0}" == 1 ]]; then exit 1; fi
`)
    command('sudo', `
echo "sudo $*" >> "$TEST_LOG"
if [[ "\${TEST_SUDO_FAILURE:-0}" == 1 ]]; then echo "sudo: interactive authentication is required" >&2; exit 1; fi
shift
exec "$@"
`)
    command('rsync', 'echo "rsync" >> "$TEST_LOG"')
    command('ssh', `
echo "ssh $*" >> "$TEST_LOG"
case "$*" in
  *"sed -n"*) printf 'test-anon\\ntest-service\\n' ;;
  *"bash -s"*) bash ;;
  *"cat >"*) umask 077; cat > "$DEPLOY_PATH/deploy/.env.production" ;;
  *"docker compose"*) echo "app rebuilt" >> "$TEST_LOG" ;;
esac
`)
    const logPath = path.join(root, 'commands.log')
    writeFileSync(logPath, '')
    const invoke = (script = 'sync-production-nginx.sh', args: string[] = [], extra: Record<string, string> = {}) => spawnSync(
      'bash', [path.join(root, 'scripts', script), ...args], {
        encoding: 'utf8',
        env: {
          ...process.env, PATH: `${path.join(root, 'bin')}:${process.env.PATH}`,
          DEPLOY_PATH: root, NGINX_SITE_PATH: site, TMPDIR: path.join(root, 'backups'),
          TEST_LOG: logPath, ...extra,
        },
      },
    )
    run({ root, target, site, log: () => readFileSync(logPath, 'utf8'), invoke })
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

describe('safe production nginx synchronization', () => {
  it('checks drift without privilege or changes and skips an unchanged site', () => {
    fixture(({ target, invoke, log }) => {
      const drift = invoke(undefined, ['--check'], { TEST_UID: '1000' })
      assert.equal(drift.status, 3)
      assert.equal(readFileSync(target, 'utf8'), old)
      assert.equal(log(), '')
      writeFileSync(target, desired)
      const unchanged = invoke(undefined, [], { TEST_UID: '1000' })
      assert.equal(unchanged.status, 0, String(unchanged.stderr))
      assert.match(String(unchanged.stdout), /no reload required/)
      assert.equal(log(), '')
    })
  })

  it('installs and reloads validated settings, preserving the enabled symlink', () => {
    fixture(({ root, target, site, invoke, log }) => {
      chmodSync(target, 0o640)
      const result = invoke()
      assert.equal(result.status, 0, String(result.stderr))
      assert.equal(readFileSync(target, 'utf8'), desired)
      assert.equal(readlinkSync(site), target)
      assert.equal(statSync(target).mode & 0o777, 0o640)
      assert.equal(log(), 'nginx -t\nnginx -t\nsystemctl reload nginx\n')
      assert.deepEqual(readdirSync(path.join(root, 'backups')), [])
    })
  })

  it('restores the previous site when candidate validation fails', () => {
    fixture(({ root, target, invoke, log }) => {
      const result = invoke(undefined, [], { TEST_VALIDATION_FAILURE: '1' })
      assert.notEqual(result.status, 0)
      assert.match(String(result.stderr), /failed validation.*not be activated/)
      assert.equal(readFileSync(target, 'utf8'), old)
      assert.equal(log(), 'nginx -t\nnginx -t\nnginx -t\nsystemctl reload nginx\n')
      assert.deepEqual(readdirSync(path.join(root, 'backups')), [])
    })
  })

  it('restores and reloads the previous site when candidate reload fails', () => {
    fixture(({ target, invoke, log }) => {
      const result = invoke(undefined, [], { TEST_RELOAD_FAILURE: '1' })
      assert.notEqual(result.status, 0)
      assert.equal(readFileSync(target, 'utf8'), old)
      assert.equal(log(), 'nginx -t\nnginx -t\nsystemctl reload nginx\nnginx -t\nsystemctl reload nginx\n')
      assert.match(String(result.stderr), /Nginx reload failed/)
    })
  })

  it('retains a scoped backup and reports manual recovery if rollback cannot reload', () => {
    fixture(({ root, invoke, target }) => {
      const result = invoke(undefined, [], { TEST_ROLLBACK_FAILURE: '1' })
      assert.notEqual(result.status, 0)
      assert.match(String(result.stderr), /rollback failed.*manual recovery is required/)
      assert.equal(readFileSync(target, 'utf8'), old)
      const backups = readdirSync(path.join(root, 'backups'))
      assert.equal(backups.length, 1)
      assert.equal(readFileSync(path.join(root, 'backups', backups[0]), 'utf8'), old)
    })
  })

  it('fails explicitly before changes when privilege or an existing enabled site is missing', () => {
    fixture(({ invoke, target, log, root }) => {
      const denied = invoke(undefined, [], { TEST_UID: '1000' })
      assert.notEqual(denied.status, 0)
      assert.match(String(denied.stderr), /requires sudo/)
      assert.equal(readFileSync(target, 'utf8'), old)
      assert.equal(log(), '')
      const missing = invoke(undefined, ['--check'], { NGINX_SITE_PATH: path.join(root, 'missing-site') })
      assert.notEqual(missing.status, 0)
      assert.match(String(missing.stderr), /first installation/)
    })

    it('stops a deployment when the enabled nginx site is missing', () => {
      fixture(({ invoke, root, log }) => {
        const result = invoke('deploy.sh', [], { NGINX_SITE_PATH: path.join(root, 'missing-site') })
        assert.notEqual(result.status, 0)
        assert.match(String(result.stderr), /Cannot verify the installed nginx site/)
        assert.doesNotMatch(log(), /cat >|app rebuilt|sudo /)
      })
    })
  })
})

describe('deployment nginx drift guard', () => {
  it('deploys the shared five-minute model timeout by default while preserving explicit overrides', () => {
    for (const override of ['', '120000', '600000']) {
      fixture(({ root, invoke, target }) => {
        writeFileSync(target, desired)
        const result = invoke('deploy.sh', [], { LLM_TIMEOUT_MS: override })
        assert.equal(result.status, 0, String(result.stderr))
        const environment = readFileSync(path.join(root, 'deploy/.env.production'), 'utf8')
        const timeout = environment.match(/^LLM_TIMEOUT_MS=(\d+)$/m)
        assert(timeout)
        assert.equal(Number(timeout[1]), override ? Number(override) : getLlamaConfig({}).timeoutMs)
        assert.equal(statSync(path.join(root, 'deploy/.env.production')).mode & 0o777, 0o600)
      })
    }
    fixture(({ root, invoke, target }) => {
      writeFileSync(target, desired)
      writeFileSync(path.join(root, '.env.local'), 'API_SPORTS_KEY=test-key\nLLM_TIMEOUT_MS=600000\n')
      for (const override of ['', '300000']) {
        const result = invoke('deploy.sh', [], { LLM_TIMEOUT_MS: override })
        assert.equal(result.status, 0, String(result.stderr))
        assert.match(readFileSync(path.join(root, 'deploy/.env.production'), 'utf8'),
          new RegExp(`^LLM_TIMEOUT_MS=${override || '600000'}$`, 'm'))
      }
    })
  })

  it('stops before environment changes or app rebuild if drift needs interactive sudo', () => {
    fixture(({ invoke, target, log }) => {
      const result = invoke('deploy.sh', [], { TEST_SUDO_FAILURE: '1' })
      assert.notEqual(result.status, 0)
      assert.match(String(result.stderr), /sudo bash.*sync-production-nginx/)
      assert.match(String(result.stderr), /deployment stopped before rebuilding/)
      assert.equal(readFileSync(target, 'utf8'), old)
      assert.doesNotMatch(log(), /cat >|app rebuilt/)
    })
  })

  it('synchronizes a drifted site before completing the app deployment', () => {
    fixture(({ invoke, target, log }) => {
      const result = invoke('deploy.sh')
      assert.equal(result.status, 0, String(result.stderr))
      assert.equal(readFileSync(target, 'utf8'), desired)
      assert(log().indexOf('systemctl reload nginx') < log().indexOf('app rebuilt'))
      assert.match(log(), /app rebuilt/)
    })
  })

  it('does not request sudo or reload a matching nginx site', () => {
    fixture(({ invoke, target, log }) => {
      writeFileSync(target, desired)
      const result = invoke('deploy.sh', [], { TEST_SUDO_FAILURE: '1' })
      assert.equal(result.status, 0, String(result.stderr))
      assert.doesNotMatch(log(), /sudo |systemctl/)
      assert.match(log(), /app rebuilt/)
    })
  })
})
