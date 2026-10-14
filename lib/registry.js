/**
 * dsh-remote-gui — host registry.
 *
 * The persistent list of remote hosts registered from the panel, stored as
 * `$DSH_HOME/remote-gui-hosts.json` (`{ hosts: [...] }`). Pure file I/O:
 * no tunnels, no network, no remote calls.
 *
 * A failed read yields an empty list and a failed write is swallowed on purpose —
 * an unwritable registry must not take the whole plugin down.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

class Registry {
  constructor(file) {
    this.file = file
    this.hosts = []
    this.load()
  }

  load() {
    try {
      const parsed = JSON.parse(readFileSync(this.file, 'utf8'))
      this.hosts = Array.isArray(parsed?.hosts) ? parsed.hosts : []
    } catch { this.hosts = [] }
  }

  save() {
    try {
      mkdirSync(dirname(this.file), { recursive: true })
      writeFileSync(this.file, JSON.stringify({ hosts: this.hosts }, null, 2), 'utf8')
    } catch { /* 注册表写不进去不该拖垮插件 */ }
  }

  find(id) {
    if (!id) return undefined
    return this.hosts.find((h) => h.id === id) ?? this.hosts.find((h) => h.alias === id)
  }

  upsert(host) {
    const at = this.hosts.findIndex((h) => h.id === host.id)
    if (at >= 0) this.hosts[at] = { ...this.hosts[at], ...host }
    else this.hosts.push(host)
    this.save()
    return this.find(host.id)
  }

  remove(id) {
    const before = this.hosts.length
    this.hosts = this.hosts.filter((h) => h.id !== id)
    this.save()
    return this.hosts.length !== before
  }
}

export { Registry }
