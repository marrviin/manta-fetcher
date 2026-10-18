import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { parse as parseYaml } from 'yaml';
import { profilesDir } from '../paths.js';
import { SiteProfileSchema, type LoadedProfile, type ProfileAdapter, type SiteProfile } from './schema.js';

const PROFILE_EXTS = new Set(['.yaml', '.yml', '.js', '.mjs']);

export function patternToRegex(pattern: string): RegExp {
  // * 匹配任意字符（含 /），简单可预期；需要更细的匹配时写多个 pattern
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  return new RegExp(`^${escaped}$`);
}

export function sanitizeToolName(site: string): string {
  const t = site.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  return t || 'site';
}

/** profile 段级深合并：yaml 字段优先；数组与函数整体替换；adapter.overrides 提供段内缺省 */
function mergeProfile(
  base: Record<string, unknown>,
  override: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...base };
  for (const [k, v] of Object.entries(override)) {
    const b = out[k];
    out[k] =
      v !== null &&
      b !== null &&
      typeof v === 'object' && !Array.isArray(v) && typeof b === 'object' && !Array.isArray(b)
        ? mergeProfile(b as Record<string, unknown>, v as Record<string, unknown>)
        : v;
  }
  return out;
}

export class ProfileRegistry {
  private entries = new Map<string, LoadedProfile>();
  private mtimes = new Map<string, number>();

  constructor(private dir: string = profilesDir) {}

  /** 扫描目录，只重新加载变化的文件，返回本次变化的站点名 */
  async reload(): Promise<string[]> {
    const changed: string[] = [];
    if (!fs.existsSync(this.dir)) return changed;

    const files = fs
      .readdirSync(this.dir)
      .filter((f) => PROFILE_EXTS.has(path.extname(f)) && !f.startsWith('.'))
      .map((f) => path.join(this.dir, f));

    const seen = new Set<string>();
    for (const file of files) {
      const mtime = fs.statSync(file).mtimeMs;
      seen.add(file);
      if (this.mtimes.get(file) === mtime) continue;
      this.mtimes.set(file, mtime);
      try {
        const loaded = await this.loadFile(file, mtime);
        if (loaded) {
          this.entries.set(loaded.def.name, loaded);
          changed.push(loaded.def.name);
        }
      } catch (err) {
        // 单个 profile 坏掉不影响其他站点
        console.error(`[manta-fetcher] 加载 profile 失败: ${file}\n  ${err instanceof Error ? err.message : err}`);
        this.entries.delete(path.basename(file));
      }
    }
    // 文件被删除时移除对应 profile
    for (const file of [...this.mtimes.keys()]) {
      if (!seen.has(file)) {
        this.mtimes.delete(file);
        const name = [...this.entries.values()].find((e) => e.filePath === file)?.def.name;
        if (name) this.entries.delete(name);
      }
    }
    return changed;
  }

  private async loadFile(file: string, mtime: number): Promise<LoadedProfile | null> {
    const ext = path.extname(file);
    let raw: Partial<SiteProfile> & ProfileAdapter = {};
    if (ext === '.yaml' || ext === '.yml') {
      raw = parseYaml(fs.readFileSync(file, 'utf8'));
    } else {
      const mod = await import(pathToFileURL(file).href);
      raw = mod.default ?? mod;
    }
    if (!raw || typeof raw !== 'object' || !raw.name) return null;

    let adapterPrepare: ProfileAdapter['prepare'];
    if (raw.adapter) {
      const adapterPath = path.resolve(path.dirname(file), raw.adapter);
      const mod = (await import(pathToFileURL(adapterPath).href)) as { default?: ProfileAdapter } & ProfileAdapter;
      const adapter = mod.default ?? mod;
      // 段级深合并：adapter.overrides 只补 yaml 未写的字段，不再整体覆盖同名段
      raw = mergeProfile(
        (adapter.overrides ?? {}) as Record<string, unknown>,
        raw as unknown as Record<string, unknown>,
      ) as Partial<SiteProfile> & ProfileAdapter;
      adapterPrepare = adapter.prepare;
    }

    const def = SiteProfileSchema.parse(raw);
    return {
      def,
      toolName: `fetch_${sanitizeToolName(def.name)}`,
      loginToolName: `login_${sanitizeToolName(def.name)}`,
      filePath: file,
      mtime,
      prepare: adapterPrepare,
    };
  }

  list(): LoadedProfile[] {
    return [...this.entries.values()].sort((a, b) => a.def.name.localeCompare(b.def.name));
  }

  byName(name: string): LoadedProfile | null {
    return this.entries.get(name) ?? null;
  }

  byToolName(toolName: string): LoadedProfile | null {
    return this.list().find((e) => e.toolName === toolName) ?? null;
  }

  /** 按 URL 匹配 profile；声明在前者优先 */
  match(url: string): LoadedProfile | null {
    for (const entry of this.list()) {
      for (const pattern of entry.def.match) {
        if (patternToRegex(pattern).test(url)) return entry;
      }
    }
    return null;
  }
}
