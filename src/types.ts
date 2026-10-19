export type Category = 'Agents' | 'Skills' | 'Commands' | 'Models' | 'MCP Servers' | 'Plugins' | 'Instructions';
export type Value = Record<string, any>;
export interface Source { path: string; realpath: string; kind: string }
export interface ModelCapacity { provider: string; model: string; context: number; source: { url: string; checked: string; sha256: string } }
export interface PromptSize { count: number; approximate: true; encoding: 'o200k_base' }
export interface Entry { id: string; name: string; category: Category; description: string; data: Value; prompt?: string; promptSize?: PromptSize; sources: Source[]; provenance: Record<string, string>; modelCapacity?: ModelCapacity }
export interface Snapshot { root: string; realpath: string; loadedAt: string; entries: Entry[]; warnings: string[]; theme: import('./theme').ThemeInfo }
