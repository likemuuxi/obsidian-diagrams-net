/**
 * 图表版本历史：AI 应用前把当前图表 XML 快照持久化到插件目录下的 history/，
 * 按图表 xmlPath 分组存储，每图上限 20 条滚动淘汰。
 * 快照大且多，存独立 JSON 文件而非 data.json，避免撑爆设置文件。
 *
 * 读写走 vault.adapter（直接磁盘 IO）而非 TFile API：
 * Obsidian 的文件索引不包含 .obsidian 隐藏目录，重启/重载后 getAbstractFileByPath 找不到这些文件。
 */
import { Vault } from 'obsidian';

export interface HistoryEntry {
	/** 保存时间戳（ms） */
	ts: number;
	/** 触发本轮 AI 修改的 prompt（列表摘要用） */
	prompt: string;
	/** 应用前的完整图表 XML */
	xml: string;
	/** 恢复历史前自动保存的临时快照：被恢复后即删除，不长期占位 */
	temp?: boolean;
}

/** 每图保留的版本上限，超出滚动淘汰最旧 */
const MAX_ENTRIES_PER_DIAGRAM = 20;

/** xmlPath → 历史文件名：替换路径与 Windows 保留字符，保证落在 history/ 单层目录内 */
function historyFilePath(pluginDir: string, xmlPath: string): string {
	const safe = xmlPath.replace(/[\\/:*?"<>|]/g, '_');
	return `${pluginDir}/history/${safe}.json`;
}

/** 追加一条快照（AI 应用前调用）；temp=true 标记为恢复历史前的临时快照。失败只警告不抛出，不影响主流程 */
export async function saveHistorySnapshot(vault: Vault, pluginDir: string, xmlPath: string, xml: string, prompt: string, temp = false): Promise<void> {
	try {
		const dir = `${pluginDir}/history`;
		if (!(await vault.adapter.exists(dir))) {
			await vault.adapter.mkdir(dir);
		}
		const entries = await loadHistory(vault, pluginDir, xmlPath);
		entries.push(temp ? { ts: Date.now(), prompt, xml, temp: true } : { ts: Date.now(), prompt, xml });
		const trimmed = entries.length > MAX_ENTRIES_PER_DIAGRAM ? entries.slice(-MAX_ENTRIES_PER_DIAGRAM) : entries;
		await vault.adapter.write(historyFilePath(pluginDir, xmlPath), JSON.stringify({ entries: trimmed }));
	}
	catch (e) {
		console.warn('[diagrams-net] failed to save history snapshot:', e);
	}
}

/**
 * 恢复历史前的临时快照刷新：删除现有全部 temp 条目，把当前画布存为新的唯一 temp。
 * 保证任何时刻"最近一次跳走的画布状态"都可一键回退（恢复 temp 目标自身时等价于 A/B 交换）。
 */
export async function refreshTempSnapshot(vault: Vault, pluginDir: string, xmlPath: string, xml: string | null, prompt: string): Promise<void> {
	try {
		const dir = `${pluginDir}/history`;
		if (!(await vault.adapter.exists(dir))) {
			await vault.adapter.mkdir(dir);
		}
		const entries = await loadHistory(vault, pluginDir, xmlPath);
		const kept = entries.filter(e => !e.temp);
		if (xml) kept.push({ ts: Date.now(), prompt, xml, temp: true });
		const trimmed = kept.length > MAX_ENTRIES_PER_DIAGRAM ? kept.slice(-MAX_ENTRIES_PER_DIAGRAM) : kept;
		const path = historyFilePath(pluginDir, xmlPath);
		if (!trimmed.length) {
			if (await vault.adapter.exists(path)) await vault.adapter.remove(path);
		} else {
			await vault.adapter.write(path, JSON.stringify({ entries: trimmed }));
		}
	}
	catch (e) {
		console.warn('[diagrams-net] failed to refresh temp snapshot:', e);
	}
}

/** 读取某图表的历史列表（旧→新排列）；文件不存在或损坏返回空数组 */
export async function loadHistory(vault: Vault, pluginDir: string, xmlPath: string): Promise<HistoryEntry[]> {
	try {
		const path = historyFilePath(pluginDir, xmlPath);
		if (!(await vault.adapter.exists(path))) return [];
		const data = JSON.parse(await vault.adapter.read(path));
		if (!Array.isArray(data?.entries)) return [];
		return data.entries;
	}
	catch {
		return [];
	}
}
