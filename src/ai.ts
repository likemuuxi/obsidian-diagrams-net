/**
 * AI 作图模块：调用 OpenAI 兼容接口（OpenAI / DeepSeek / Kimi / OpenRouter / Ollama 等），
 * 用自然语言生成或修改 drawio 的 mxGraph XML，并在本地做校验与自动修复。
 * 已知 LLM 通病：漏根 cell、幻觉 id、几何缺 as 属性 —— 这里统一程序化修复。
 */

import { requestUrl } from 'obsidian';
import { t } from './lang/helpers';
import { DiagramsSettings } from './settings';

const DEFAULT_AI_ENDPOINT = 'https://api.openai.com/v1';

// 提示词规则取自 drawio 官方 skill（jgraph/drawio-mcp）的 XML 参考要点
const SYSTEM_PROMPT = [
	'You are a diagrams.net (draw.io) diagram XML generator.',
	'Return ONLY the raw XML of an <mxfile> document. No markdown fences, no explanations, no XML comments.',
	'Required skeleton:',
	'<mxfile><diagram><mxGraphModel adaptiveColors="auto"><root><mxCell id="0"/><mxCell id="1" parent="0"/>{cells}</root></mxGraphModel></diagram></mxfile>',
	'The content inside <diagram> MUST be the plain, readable <mxGraphModel> XML shown above.',
	'NEVER base64-encode or deflate-compress the diagram content (as exported .drawio files do) - always write every mxCell as plain XML text.',
	'Rules:',
	'- Every mxCell must have a unique id. Never write parent equal to the cell\'s own id (e.g. id="1" parent="1" hides everything).',
	'- Escape special characters in attribute values: &amp; &lt; &gt; &quot;. An edge\'s source/target must reference an existing vertex id.',
	'- Vertex: <mxCell id="n1" value="Label" style="rounded=1;whiteSpace=wrap;html=1;" vertex="1" parent="1"><mxGeometry x="40" y="40" width="140" height="60" as="geometry"/></mxCell>',
	'- Edge: <mxCell id="e1" style="edgeStyle=orthogonalEdgeStyle;rounded=1;html=1;exitX=0.5;exitY=1;entryX=0.5;entryY=0;defaultLabelBackgroundColor=page;" edge="1" source="n1" target="n2" parent="1"><mxGeometry relative="1" as="geometry"/></mxCell>. Edges are NEVER self-closing and always carry the <mxGeometry> child.',
	'- Every style includes html=1. Line breaks in labels use <br>, never \\n. Keep edge labels to 1-3 words.',
	'- Shapes: rounded=1 for process boxes, rhombus for decisions, ellipse for start/end, shape=cylinder3 for databases, text for annotations, dashed=1 for optional steps.',
	'Edge routing rules (CRITICAL for a clean diagram):',
	'- Every edge MUST include explicit exitX/exitY (on the source) and entryX/entryY (on the target) style attributes. 0/1 are the border coordinates of that side, 0.5 the middle.',
	'- Match anchors to flow direction: top-down flow exits bottom (exitX=0.5;exitY=1) and enters top (entryX=0.5;entryY=0); left-right flow exits right (exitX=1;exitY=0.5) and enters left (entryX=0;entryY=0.5). NEVER connect corner-to-corner (e.g. exitX=1;exitY=1 is forbidden).',
	'- When 2 edges attach to the SAME side of a shape, stagger the anchors: one at 0.3 and the other at 0.7 instead of both at 0.5, so the lines do not overlap.',
	'- If the straight orthogonal path would cross an unrelated shape, add waypoints: <mxGeometry relative="1" as="geometry"><Array as="points"><mxPoint x="470" y="200"/></Array></mxGeometry>. Route around the obstacle leaving a 20-30px clearance.',
	'Layout rules (CRITICAL for a clean diagram):',
	'- Keep 150-200px spacing between neighboring shapes so edges have corridors to route through; no overlapping or tangent shapes.',
	'- Fit the whole diagram in one viewport: keep every coordinate within x ∈ [0,800] and y ∈ [0,600] unless the user explicitly asks for a larger diagram.',
	'- Size shapes from their text: width ≈ 8px per latin character or 15px per CJK character plus 20px padding; minimum box 120x40. For long labels use whiteSpace=wrap and increase the height instead of overflowing.',
	'- Place shapes on a grid and keep one consistent flow direction (top-down or left-right) per diagram.',
	'- Containers/groups: style "swimlane;startSize=24;..." or "group;", children use parent="<container_id>" with coordinates relative to it. An edge\'s parent is the innermost container holding BOTH endpoints, otherwise "1".',
	'- Horizontal swimlanes: lane cells styled "swimlane;horizontal=0;startSize=110;" at x=0, y=lane*150, height=150; nodes inside at x=120+col*180, y=45.',
	"- Write label text in the same language as the user's request.",
	'- Keep it compact: at most ~30 cells unless the user asks for more.',
	'- Always generate the COMPLETE diagram: a flowchart must include every step from start to end (typically 6-15 nodes) plus the edges connecting them. Never stop after one or two nodes.',
	'- Earlier conversation turns are context for iterative refinement; references like "again" or "same style" refer to them.',
	'Editing mode: when a Current diagram XML is provided and the change is small (rename, recolor, add/delete a few cells), call the edit_diagram tool with the smallest possible operations list - it preserves the user layout. Use display_diagram (full XML) only for new diagrams or major restructuring. When returning full XML for an edit, keep every cell you are not asked to change (id, geometry, style) exactly as given.',
	'Before returning, self-check the XML: no edge crosses through a shape, no two shapes overlap, no corner-to-corner edges, no collinear (overlapping) edge segments, no duplicate ids. Fix every issue you find before outputting.',
].join('\n');

export function isAIConfigured(settings: DiagramsSettings): boolean {
	return !!settings.aiApiKey && settings.aiApiKey.trim().length > 0;
}

/** 多轮对话消息（不含系统提示词；assistant 只存简短确认，不回传 XML 省 token） */
export interface AiChatMessage {
	role: 'user' | 'assistant';
	content: string;
}

/** 回传给模型的历史条数上限（约 5 轮），避免请求体膨胀 */
const MAX_HISTORY_MESSAGES = 10;

// 现有图表 XML 超过该长度（约 2.5 万 token）时拒绝发送，避免超出模型上下文或天价账单
const MAX_EXISTING_XML_CHARS = 100_000;

/** 校验失败自动回传模型修复的最大轮数 */
const MAX_REPAIR_ATTEMPTS = 2;

/** edit_diagram 单次操作（update / add / delete），字段按 action 取用 */
export interface EditOperation {
	action: 'update' | 'add' | 'delete';
	/** update / delete 的目标 cell id */
	id?: string;
	/** update：新标签文本 */
	value?: string;
	/** update：完整新 style 串 */
	style?: string;
	/** update：新几何，未给出的键保持原值 */
	geometry?: { x?: number; y?: number; width?: number; height?: number };
	/** add：完整的 <mxCell> XML 元素文本 */
	xml?: string;
}

/** 本次请求的 token 用量：prompt 输入 / completion 输出 */
export interface AiTokenUsage {
	promptTokens?: number;
	completionTokens?: number;
}

/** 从 OpenAI 兼容响应的 usage 对象提取 token 数；无有效数值返回 undefined */
function readUsage(u: any): AiTokenUsage | undefined {
	if (!u || typeof u !== 'object') return undefined;
	const p = typeof u.prompt_tokens === 'number' ? u.prompt_tokens : undefined;
	const c = typeof u.completion_tokens === 'number' ? u.completion_tokens : undefined;
	return p === undefined && c === undefined ? undefined : { promptTokens: p, completionTokens: c };
}

/** 用量展示文案（"↑1.2k ↓345"）；缺某侧只显示另一侧，无数据返回空串 */
export function formatTokenUsage(usage?: AiTokenUsage): string {
	if (!usage) return '';
	const fmt = (n?: number) => n === undefined ? null : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
	const up = fmt(usage.promptTokens);
	const down = fmt(usage.completionTokens);
	if (up === null && down === null) return '';
	return `${up !== null ? `↑${up}` : ''}${up !== null && down !== null ? ' ' : ''}${down !== null ? `↓${down}` : ''}`;
}

/** 生成结果：mode 标记全量重画 / 增量编辑，changedIds 供变更高亮 */
export interface AiGenerateResult {
	xml: string;
	mode: 'full' | 'edit';
	/** 增量编辑命中的 cell id（update/add/delete 涉及的） */
	changedIds?: string[];
	/** 推理模型的思考过程（DeepSeek-R1 风格 reasoning_content），普通模型为空 */
	reasoning?: string;
	/** 本轮生成的 token 用量（含修复重试轮次的累加）；网关未返回时为空 */
	usage?: AiTokenUsage;
}

/**
 * function calling 工具定义（OpenAI 兼容格式）。
 * display_diagram = 全量重画（新建/大改）；edit_diagram = 按 cell id 的小步增量修改。
 */
const AI_TOOLS = [
	{
		type: 'function',
		function: {
			name: 'display_diagram',
			description: 'Create a new diagram, or replace/restructure the current one heavily. Returns the COMPLETE <mxfile> XML.',
			parameters: {
				type: 'object',
				properties: {
					xml: { type: 'string', description: 'The complete <mxfile> XML document.' },
				},
				required: ['xml'],
			},
		},
	},
	{
		type: 'function',
		function: {
			name: 'edit_diagram',
			description: 'Apply small edits to the CURRENT diagram (rename, restyle, move/resize, add or delete a few cells) without redrawing it. Preserves the existing layout and all untouched cells.',
			parameters: {
				type: 'object',
				properties: {
					operations: {
						type: 'array',
						description: 'Ordered list of operations to apply to the current diagram.',
						items: {
							type: 'object',
							properties: {
								action: { type: 'string', enum: ['update', 'add', 'delete'] },
								id: { type: 'string', description: 'Target cell id (for update/delete).' },
								value: { type: 'string', description: 'New label text (update only).' },
								style: { type: 'string', description: 'New complete style string (update only).' },
								geometry: {
									type: 'object',
									description: 'New geometry (update only). Omitted keys keep current values.',
									properties: {
										x: { type: 'number' },
										y: { type: 'number' },
										width: { type: 'number' },
										height: { type: 'number' },
									},
								},
								xml: { type: 'string', description: 'Complete <mxCell> XML element to insert (add only).' },
							},
							required: ['action'],
						},
					},
				},
				required: ['operations'],
			},
		},
	},
];

/**
 * 生成（或按指令修改）图表 XML。
 * 带截断检测与校验闭环：输出被 max_tokens 截断时给出明确提示；
 * 解析失败 / 工具调用无效时把错误回传模型要求修复，最多重试 MAX_REPAIR_ATTEMPTS 轮。
 * @param userPrompt 自然语言描述 / 修改指令
 * @param existingXml 修改模式下传现有图表 XML，省略则为新建
 * @param history 多轮对话历史（不含本次 prompt），用于迭代式改图
 * @param imageDataUrl 可选图片（vision 模型）：复刻图片内容为可编辑图表
 * @param onProgress 可选流式进度回调（思考 / 生成中接收的累计字符数）
 * @returns xml 可直接交给 drawio 编辑器；mode 区分全量 / 增量；changedIds 为增量命中 cell
 */
export async function generateDiagramXml(
	userPrompt: string,
	settings: DiagramsSettings,
	existingXml?: string,
	history?: AiChatMessage[],
	imageDataUrl?: string,
	onProgress?: AiProgressFn
): Promise<AiGenerateResult> {
	const endpoint = (settings.aiEndpoint || DEFAULT_AI_ENDPOINT).trim().replace(/\/+$/, '');
	// 现有 XML 若是压缩格式，先解压成明文再喂给模型，避免模型模仿压缩格式返回
	const plainExisting = existingXml ? await inflateDiagramContent(existingXml) : undefined;
	if (plainExisting && plainExisting.length > MAX_EXISTING_XML_CHARS) {
		throw new Error(t('AI_CONTEXT_TOO_LARGE'));
	}
	const textContent = plainExisting
		? `Current diagram XML:\n${plainExisting}\n\nApply this change: ${userPrompt}`
		: userPrompt;
	// 图片复刻指令：有图时追加，要求模型忠实还原图片中的图表
	const visionSuffix = imageDataUrl
		? '\nAlso replicate the attached image as an editable draw.io diagram: recreate every shape, label and connection as faithfully as possible.'
		: '';
	// OpenAI 兼容多模态格式：图片走 content 数组的 image_url 项
	const userMessage: { role: string; content: any } = imageDataUrl
		? {
			role: 'user',
			content: [
				{ type: 'text', text: textContent + visionSuffix },
				{ type: 'image_url', image_url: { url: imageDataUrl } },
			],
		}
		: { role: 'user', content: textContent };

	const messages: Array<{ role: string; content: any }> = [
		{ role: 'system', content: SYSTEM_PROMPT },
		...(history ?? [])
			.filter(m => (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string' && m.content.trim())
			.slice(-MAX_HISTORY_MESSAGES)
			.map(m => ({ role: m.role, content: m.content })),
		userMessage,
	];

	// 优先尝试 function calling；网关不支持时自动降级为纯文本
	let useTools = true;
	// 推理模型的思考过程（reasoning_content / reasoning 两种字段名兼容），保留最后一轮非空值
	let lastReasoning: string | undefined;
	// token 用量：修复重试轮次逐轮累加（含降级前的失败请求时不计，因其未返回响应体）
	let totalUsage: AiTokenUsage | undefined;
	const trackUsage = (data: any) => {
		const u = readUsage(data?.usage);
		if (!u) return;
		totalUsage = {
			promptTokens: (totalUsage?.promptTokens ?? 0) + (u.promptTokens ?? 0),
			completionTokens: (totalUsage?.completionTokens ?? 0) + (u.completionTokens ?? 0),
		};
	};

	for (let attempt = 0; attempt <= MAX_REPAIR_ATTEMPTS; attempt++) {
		let data: any;
		try {
			data = await requestChatCompletion(endpoint, settings, messages, useTools, onProgress);
		}
		catch (err: any) {
			// 网关/模型不支持 function calling（报错提及 tool/function）时降级为纯文本模式重试
			if (useTools && /tool|function/i.test(String(err?.message || ''))) {
				useTools = false;
				attempt--; // 降级不算修复重试轮次
				continue;
			}
			// 携带图片时报错提及 image/vision/multimodal：大概率是非 vision 模型
			if (imageDataUrl && /image|vision|multimodal|modalit/i.test(String(err?.message || ''))) {
				throw new Error(`${t('AI_VISION_NOT_SUPPORTED')}`);
			}
			throw err;
		}
		trackUsage(data);
		const choice = data?.choices?.[0];
		// 截断检测：max_tokens 用尽时是半截 XML，重试同样会被截断，直接给可行动的提示
		if (choice?.finish_reason === 'length') {
			throw new Error(t('AI_OUTPUT_TRUNCATED'));
		}
		const message = choice?.message;
		const reasoning: string | undefined = typeof message?.reasoning_content === 'string' && message.reasoning_content.trim()
			? message.reasoning_content
			: (typeof message?.reasoning === 'string' && message.reasoning.trim() ? message.reasoning : undefined);
		if (reasoning) lastReasoning = reasoning;
		const content: string | undefined = typeof message?.content === 'string' ? message.content : undefined;

		// function calling 分支：优先处理 edit_diagram / display_diagram 工具调用
		if (Array.isArray(message?.tool_calls) && message.tool_calls.length > 0) {
			const applied = await applyToolCalls(message.tool_calls, plainExisting);
			if (applied) return { ...applied, reasoning: lastReasoning, usage: totalUsage };
			// 工具调用不可解析 / 未命中任何 cell：回传修复
			messages.push({
				role: 'user',
				content: 'Your tool call was invalid or matched no cells in the current diagram. Re-check the existing cell ids, then call the tool again with corrected arguments (edit_diagram for small edits, display_diagram for a full redraw).',
			});
			continue;
		}

		if (!content) {
			throw new Error(`${t('AI_GENERATE_FAILED')}: ${t('AI_INVALID_RESPONSE')}`);
		}
		const xml = await extractAndFixXml(content);
		if (xml) return { xml, mode: 'full', reasoning: lastReasoning, usage: totalUsage };
		// 校验闭环：把无效输出回传模型要求修复后重试（而非直接报错）
		messages.push(
			{ role: 'assistant', content },
			{ role: 'user', content: 'Your previous reply was not a valid draw.io XML document (no parseable <mxfile>/<mxGraphModel> could be extracted). Return the complete corrected <mxfile> XML now. Raw XML only - no markdown fences, no explanations.' }
		);
	}
	throw new Error(t('AI_INVALID_RESPONSE'));
}

/** 图→文字逆向生成的系统提示词：读 XML，产出面向人的 Markdown 内容说明 */
const DESCRIBE_PROMPT = [
	'You are a technical writer. The user provides the XML of a diagrams.net (draw.io) diagram.',
	'Write a concise, well-structured Markdown document describing what the diagram shows:',
	'- Start with a one-sentence summary of the diagram\'s purpose.',
	'- Then describe the structure: list the shapes with their labels (grouped by container/lane/role when present), and walk through the connections following edge directions and labels.',
	'- Preserve the original label language exactly; do not translate.',
	'- Do not mention XML, mxCell, ids or styles - describe only the visual and semantic content.',
	'- Output Markdown only: headings, bold labels and nested bullet lists. No code fences, no explanations about this instruction.',
].join('\n');

export interface AiDescribeResult {
	/** Markdown 格式的图表内容说明 */
	text: string;
	/** 本次请求的 token 用量 */
	usage?: AiTokenUsage;
}

/**
 * 图→文字逆向生成：把当前图表 XML 交给模型，产出描述该图内容的 Markdown 文本
 * （用于归档说明、回写笔记）。复用 chat/completions 管线但不携带 XML 工具。
 */
export async function describeDiagramXml(
	xml: string,
	settings: DiagramsSettings,
	onProgress?: AiProgressFn
): Promise<AiDescribeResult> {
	const endpoint = (settings.aiEndpoint || DEFAULT_AI_ENDPOINT).trim().replace(/\/+$/, '');
	// 压缩格式先解压，与生成管线一致
	const plain = await inflateDiagramContent(xml);
	if (plain.length > MAX_EXISTING_XML_CHARS) {
		throw new Error(t('AI_CONTEXT_TOO_LARGE'));
	}
	const messages: Array<{ role: string; content: any }> = [
		{ role: 'system', content: DESCRIBE_PROMPT },
		{ role: 'user', content: `Draw.io diagram XML:\n${plain}\n\nWrite the Markdown description of this diagram now.` },
	];
	const data = await requestChatCompletion(endpoint, settings, messages, false, onProgress);
	const choice = data?.choices?.[0];
	if (choice?.finish_reason === 'length') {
		throw new Error(t('AI_OUTPUT_TRUNCATED'));
	}
	const content = typeof choice?.message?.content === 'string' && choice.message.content.trim()
		? choice.message.content.trim()
		: undefined;
	if (!content) {
		throw new Error(`${t('AI_GENERATE_FAILED')}: ${t('AI_DESCRIBE_EMPTY_RESPONSE')}`);
	}
	return { text: content, usage: readUsage(data?.usage) };
}

/**
 * 解析模型的 tool_calls 并执行：
 * edit_diagram → 增量应用到现有 XML；display_diagram → 走修复管线的全量 XML。
 * 返回 null 表示没有可用的工具调用结果（调用方走修复闭环）。
 */
async function applyToolCalls(toolCalls: any[], plainExisting: string | undefined): Promise<AiGenerateResult | null> {
	for (const call of toolCalls) {
		const fn = call?.function;
		if (!fn || typeof fn.name !== 'string') continue;
		let args: any = {};
		try {
			args = typeof fn.arguments === 'string' && fn.arguments.trim() ? JSON.parse(fn.arguments) : {};
		}
		catch {
			return null;
		}
		if (fn.name === 'edit_diagram') {
			if (!plainExisting || !Array.isArray(args.operations) || args.operations.length === 0) return null;
			const applied = applyEditOperations(plainExisting, args.operations);
			return applied ? { xml: applied.xml, mode: 'edit', changedIds: applied.changedIds } : null;
		}
		if (fn.name === 'display_diagram') {
			if (typeof args.xml !== 'string' || !args.xml.trim()) return null;
			const xml = await extractAndFixXml(args.xml);
			return xml ? { xml, mode: 'full' } : null;
		}
	}
	return null;
}

/**
 * 把 edit_diagram 的操作列表增量应用到现有图表 XML（DOM 修改，未涉及的 cell 原样保留，
 * 用户手动调整过的布局不会被重画）。返回 null 表示没有任何操作成功命中，调用方回传模型修复。
 */
export function applyEditOperations(existingXml: string, operations: Array<EditOperation | any>): { xml: string; changedIds: string[] } | null {
	const doc = new DOMParser().parseFromString(existingXml, 'text/xml');
	if (doc.querySelector('parsererror')) return null;
	const model = doc.querySelector('mxfile mxGraphModel') || doc.querySelector('mxGraphModel');
	const root = model?.querySelector('root');
	if (!model || !root) return null;

	const allCells = () => Array.from(root.querySelectorAll('mxCell'));
	const findCell = (id: string) => allCells().find(c => c.getAttribute('id') === id) || null;
	const changedIds: string[] = [];

	for (const op of operations) {
		if (!op || typeof op.action !== 'string') continue;
		if (op.action === 'delete') {
			if (typeof op.id !== 'string' || op.id === '0' || op.id === '1') continue;
			const cell = findCell(op.id);
			if (!cell) continue;
			cell.remove();
			changedIds.push(op.id);
		}
		else if (op.action === 'update') {
			if (typeof op.id !== 'string') continue;
			const cell = findCell(op.id);
			if (!cell) continue;
			if (typeof op.value === 'string') cell.setAttribute('value', op.value);
			if (typeof op.style === 'string') cell.setAttribute('style', op.style);
			const geo = op.geometry;
			if (geo && typeof geo === 'object') {
				let g: Element | null = null;
				for (const child of Array.from(cell.children)) {
					if (child.tagName === 'mxGeometry') { g = child; break; }
				}
				if (!g) {
					g = doc.createElement('mxGeometry');
					g.setAttribute('as', 'geometry');
					if (cell.getAttribute('edge') === '1') g.setAttribute('relative', '1');
					cell.appendChild(g);
				}
				for (const key of ['x', 'y', 'width', 'height'] as const) {
					const v = (geo as any)[key];
					if (typeof v === 'number' && isFinite(v)) g.setAttribute(key, String(v));
				}
			}
			changedIds.push(op.id);
		}
		else if (op.action === 'add') {
			if (typeof op.xml !== 'string' || !op.xml.trim()) continue;
			const wrapped = new DOMParser().parseFromString(`<root>${op.xml}</root>`, 'text/xml');
			if (wrapped.querySelector('parsererror')) continue;
			const cellEl = Array.from(wrapped.documentElement.children).find(c => c.tagName === 'mxCell');
			if (!cellEl) continue;
			const id = cellEl.getAttribute('id');
			if (!id || id === '0' || id === '1') continue;
			const imported = doc.importNode(cellEl, true) as Element;
			if (!imported.getAttribute('parent')) imported.setAttribute('parent', '1');
			for (const child of Array.from(imported.children)) {
				if (child.tagName === 'mxGeometry' && !child.getAttribute('as')) child.setAttribute('as', 'geometry');
			}
			// id 冲突时替换旧 cell（模型意图是改写该元素），否则追加
			const old = findCell(id);
			if (old) old.replaceWith(imported);
			else root.appendChild(imported);
			changedIds.push(id);
		}
	}

	if (changedIds.length === 0) return null;

	// 结构清理：被删 cell 的子元素重新挂到根图层；指向已删 cell 的边引用移除
	const validIds = new Set<string>();
	for (const c of allCells()) {
		const id = c.getAttribute('id');
		if (id) validIds.add(id);
	}
	for (const c of allCells()) {
		const parent = c.getAttribute('parent');
		if (parent && parent !== '0' && parent !== '1' && !validIds.has(parent)) {
			c.setAttribute('parent', '1');
		}
		if (c.getAttribute('edge') === '1') {
			for (const ref of ['source', 'target']) {
				const id = c.getAttribute(ref);
				if (id && !validIds.has(id)) c.removeAttribute(ref);
			}
		}
	}

	return { xml: new XMLSerializer().serializeToString(doc), changedIds };
}

/**
 * 对比修改前后图表（第一页）的 cell 集合，返回新增或内容有变化的 cell id。
 * 供全量重画模式的变更高亮使用；解析失败返回空数组。
 */
export async function diffChangedCellIds(oldXml: string | null | undefined, newXml: string): Promise<string[]> {
	if (!oldXml) return [];
	const oldPlain = await inflateDiagramContent(oldXml);
	const newPlain = await inflateDiagramContent(newXml);
	const oldCells = collectCellSnapshots(oldPlain);
	const newCells = collectCellSnapshots(newPlain);
	if (!oldCells || !newCells) return [];
	const changed: string[] = [];
	for (const [id, sig] of newCells) {
		if (!oldCells.has(id) || oldCells.get(id) !== sig) changed.push(id);
	}
	return changed;
}

/** 解析第一页 mxGraphModel，生成 id → 内容签名（value/style/端点/几何）映射 */
function collectCellSnapshots(xml: string): Map<string, string> | null {
	const doc = new DOMParser().parseFromString(xml, 'text/xml');
	if (doc.querySelector('parsererror')) return null;
	const model = doc.querySelector('mxfile mxGraphModel') || doc.querySelector('mxGraphModel');
	const root = model?.querySelector('root');
	if (!root) return null;
	const map = new Map<string, string>();
	for (const cell of Array.from(root.querySelectorAll('mxCell'))) {
		const id = cell.getAttribute('id');
		if (!id || id === '0' || id === '1') continue;
		let geoSig = '';
		for (const child of Array.from(cell.children)) {
			if (child.tagName === 'mxGeometry') geoSig = new XMLSerializer().serializeToString(child);
		}
		const sig = [
			cell.getAttribute('value') || '',
			cell.getAttribute('style') || '',
			cell.getAttribute('source') || '',
			cell.getAttribute('target') || '',
			geoSig,
		].join('|');
		map.set(id, sig);
	}
	return map;
}

/** 变更高亮用的临时描边样式（onXmlUpdate 据此识别并忽略高亮期的自动上报） */
export const HIGHLIGHT_STYLE = 'strokeColor=#e58900;strokeWidth=3';

/**
 * 生成带/去高亮样式的完整文档 XML（供 drawio merge 动作与当前画布做差异合并）：
 * highlight=true 给命中 cell 追加橙色描边；highlight=false 移除描边（用于还原）。
 * 必须返回完整文档：merge 按传入文档与当前文档做 diff，传入文档缺失的 cell
 * 会被判为删除，只发命中的 cell 会清空画布其余内容。
 */
export function buildHighlightOverlay(xml: string, cellIds: string[], highlight: boolean): string | null {
	const doc = new DOMParser().parseFromString(xml, 'text/xml');
	if (doc.querySelector('parsererror')) return null;
	const model = doc.querySelector('mxfile mxGraphModel') || doc.querySelector('mxGraphModel');
	const root = model?.querySelector('root');
	if (!root) return null;
	const idSet = new Set(cellIds);
	let touched = false;
	for (const cell of Array.from(root.querySelectorAll('mxCell'))) {
		const id = cell.getAttribute('id');
		if (!id || !idSet.has(id)) continue;
		let style = cell.getAttribute('style') || '';
		if (highlight) {
			if (style.includes(HIGHLIGHT_STYLE)) continue;
			if (style && !style.endsWith(';')) style += ';';
			cell.setAttribute('style', style + HIGHLIGHT_STYLE + ';');
			touched = true;
		}
		else if (style.includes(HIGHLIGHT_STYLE)) {
			cell.setAttribute('style', style.split(HIGHLIGHT_STYLE + ';').join(''));
			touched = true;
		}
	}
	if (!touched) return null;
	return new XMLSerializer().serializeToString(doc);
}

/** 流式进度回调：phase 区分推理模型思考 / 正文生成，chars 为该阶段累计接收字符数 */
export type AiProgressFn = (phase: 'thinking' | 'generating', chars: number) => void;

/** 组装 chat/completions 请求体（stream 控制流式开关；流式时可带 stream_options 索要 usage） */
function buildChatPayload(settings: DiagramsSettings, messages: Array<{ role: string; content: any }>, useTools: boolean, stream: boolean, includeUsage = false): string {
	return JSON.stringify({
		model: settings.aiModel || 'gpt-4o',
		messages,
		temperature: 0.2,
		...(useTools ? { tools: AI_TOOLS } : {}),
		...(stream
			? { stream: true, ...(includeUsage ? { stream_options: { include_usage: true } } : {}) }
			: {}),
	});
}

/**
 * fetch + SSE 流式请求：逐 chunk 聚合成与非流式一致的响应结构（choices[0].message /
 * finish_reason），上层逻辑无感知。返回 null 表示应降级非流式（连接失败、CORS、
 * 或网关不支持 stream 静默返回普通 JSON 体）。
 */
async function requestChatCompletionStreamed(endpoint: string, settings: DiagramsSettings, messages: Array<{ role: string; content: any }>, useTools: boolean, onProgress?: AiProgressFn): Promise<any | null> {
	// 先带 stream_options(include_usage) 索要 token 用量；个别网关不认该参数报 400 时去参重试一次
	let resp: Response | null = null;
	let errStatus = 0;
	let errDetail = '';
	for (const includeUsage of [true, false]) {
		let r: Response;
		try {
			r = await fetch(`${endpoint}/chat/completions`, {
				method: 'POST',
				headers: {
					'Content-Type': 'application/json',
					'Authorization': `Bearer ${settings.aiApiKey.trim()}`,
				},
				body: buildChatPayload(settings, messages, useTools, true, includeUsage),
			});
		}
		catch {
			return null; // 连不上 / CORS 受阻 → 降级
		}
		if (r.ok && r.body) {
			resp = r;
			break;
		}
		errStatus = r.status;
		errDetail = '';
		try {
			const text = await r.text();
			errDetail = JSON.parse(text)?.error?.message || text.slice(0, 200);
		}
		catch {
			// 错误体不是 JSON 时忽略
		}
		// 400 可能只是网关不认 stream_options；401/403/429/5xx 与该参数无关，不必重试
		if (r.status !== 400) break;
	}
	if (!resp) {
		throw new Error(`HTTP ${errStatus}${errDetail ? `: ${errDetail}` : ''}`);
	}

	// 聚合结果：content / reasoning_content（DeepSeek-R1 风格）/ 流式分片的 tool_calls / 末 chunk 的 usage
	const toolCalls: Array<{ id?: string; function: { name: string; arguments: string } }> = [];
	let content = '';
	let reasoning = '';
	let finishReason: string | undefined;
	let gotData = false;
	let usage: AiTokenUsage | undefined;

	const assemble = () => {
		const message: any = {};
		if (reasoning) message.reasoning_content = reasoning;
		if (content) message.content = content;
		if (toolCalls.length) {
			message.tool_calls = toolCalls.map(tc => ({ id: tc.id ?? '', type: 'function', function: tc.function }));
		}
		if (!gotData) return null; // 空响应体（如网关忽略 stream 参数）→ 降级
		// usage 挂顶层，与非流式响应结构一致
		return { choices: [{ message, finish_reason: finishReason ?? null }], ...(usage ? { usage } : {}) };
	};

	const reader = resp.body.getReader();
	const decoder = new TextDecoder();
	let buf = '';
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			buf += decoder.decode(value, { stream: true });
			let nl: number;
			while ((nl = buf.indexOf('\n')) >= 0) {
				const line = buf.slice(0, nl).trimEnd();
				buf = buf.slice(nl + 1);
				if (!line.startsWith('data:')) continue;
				const payload = line.slice(5).trim();
				if (payload === '[DONE]') return assemble();
				let chunk: any;
				try {
					chunk = JSON.parse(payload);
				}
				catch {
					continue;
				}
				gotData = true;
				// usage 通常只在最后一个 chunk 携带（OpenAI 需 stream_options，DeepSeek 默认返回）
				const chunkUsage = readUsage(chunk.usage);
				if (chunkUsage) usage = chunkUsage;
				const choice = chunk.choices?.[0];
				if (choice?.finish_reason) finishReason = choice.finish_reason;
				const delta = choice?.delta;
				if (typeof delta?.reasoning_content === 'string' && delta.reasoning_content) {
					reasoning += delta.reasoning_content;
					onProgress?.('thinking', reasoning.length);
				}
				if (typeof delta?.reasoning === 'string' && delta.reasoning) {
					reasoning += delta.reasoning;
					onProgress?.('thinking', reasoning.length);
				}
				if (typeof delta?.content === 'string' && delta.content) {
					content += delta.content;
					onProgress?.('generating', content.length);
				}
				if (Array.isArray(delta?.tool_calls)) {
					for (const tc of delta.tool_calls) {
						const i = tc.index ?? 0;
						if (!toolCalls[i]) toolCalls[i] = { function: { name: '', arguments: '' } };
						if (tc.id) toolCalls[i].id = tc.id;
						if (typeof tc.function?.name === 'string') toolCalls[i].function.name += tc.function.name;
						if (typeof tc.function?.arguments === 'string') toolCalls[i].function.arguments += tc.function.arguments;
					}
					onProgress?.('generating', toolCalls.reduce((n, tc) => n + tc.function.name.length + tc.function.arguments.length, 0));
				}
			}
		}
		return assemble(); // 流读尽但无 [DONE] 的网关
	}
	catch (e: any) {
		if (!gotData) return null; // 流建立前失败 → 降级
		throw e; // 中途断流：交给上层修复 / 重试
	}
}

/**
 * 调 chat/completions 并统一处理网络 / HTTP 错误；useTools 控制是否携带 function calling 工具。
 * 优先 fetch 流式（可带 onProgress 进度回调），失败自动降级 requestUrl 非流式。
 */
async function requestChatCompletion(endpoint: string, settings: DiagramsSettings, messages: Array<{ role: string; content: any }>, useTools: boolean, onProgress?: AiProgressFn): Promise<any> {
	let data: any;
	try {
		data = await requestChatCompletionStreamed(endpoint, settings, messages, useTools, onProgress);
		if (data === null) {
			// 降级：requestUrl 非流式（无进度回调）
			const resp = await requestUrl({
				url: `${endpoint}/chat/completions`,
				method: 'POST',
				headers: {
					'Content-Type': 'application/json',
					'Authorization': `Bearer ${settings.aiApiKey.trim()}`,
				},
				body: buildChatPayload(settings, messages, useTools, false),
				throw: false,
			});
			if (resp.status >= 400) {
				let detail = '';
				try {
					detail = resp.json?.error?.message || '';
				}
				catch (e) {
					// 响应体不是 JSON 时忽略
				}
				throw new Error(`HTTP ${resp.status}${detail ? `: ${detail}` : ''}`);
			}
			data = resp.json;
		}
	}
	catch (e: any) {
		throw new Error(`${t('AI_GENERATE_FAILED')}: ${e?.message || e}`);
	}
	return data;
}

/** 截取文本中 <tag>...</tag> 片段 */
function sliceTag(text: string, tag: string): string | null {
	const start = text.indexOf(`<${tag}`);
	if (start === -1) return null;
	const end = text.lastIndexOf(`</${tag}>`);
	if (end === -1) return null;
	return text.slice(start, end + tag.length + 3);
}

/**
 * drawio 导出文件会把 <diagram> 内容存成 base64(deflate(xml)) 压缩串。
 * 这里检测并把压缩内容解压为明文 <mxGraphModel>，供后续修复流程使用；
 * 无效压缩串（LLM 伪数据解不开）保持原样，由调用方按无效响应处理。
 */
export async function inflateDiagramContent(fragment: string): Promise<string> {
	const doc = new DOMParser().parseFromString(fragment, 'text/xml');
	if (doc.querySelector('parsererror')) return fragment;

	const DecompressionStreamCtor = (globalThis as any).DecompressionStream;
	if (!DecompressionStreamCtor) return fragment; // 环境不支持则跳过（Obsidian/Electron 均支持）

	let changed = false;
	for (const diagram of Array.from(doc.querySelectorAll('diagram'))) {
		const text = (diagram.textContent || '').trim();
		if (!text || text.startsWith('<')) continue; // 已是明文 XML

		try {
			const binary = atob(text.replace(/\s+/g, ''));
			const bytes = new Uint8Array(binary.length);
			for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
			// 旧版 lib.dom 类型缺少 pipeThrough，运行时（Electron）实际支持
			const stream = (new Blob([bytes]).stream() as any).pipeThrough(new DecompressionStreamCtor('deflate-raw'));
			const decoded = decodeURIComponent(await new Response(stream).text());

			// 解出的明文 XML 作为元素节点替换 diagram 的文本内容
			const inner = new DOMParser().parseFromString(decoded, 'text/xml');
			if (inner.querySelector('parsererror')) continue;
			while (diagram.firstChild) diagram.removeChild(diagram.firstChild);
			diagram.appendChild(doc.importNode(inner.documentElement, true));
			changed = true;
		}
		catch {
			// 无效压缩串，保持原样
		}
	}
	return changed ? new XMLSerializer().serializeToString(doc) : fragment;
}

/**
 * 从模型输出中提取 mxfile / mxGraphModel，解析并修复常见问题：
 * 剥离 markdown 代码块、解压 base64 压缩的 diagram 内容、补齐根 cell（id=0/1）、
 * 去重复/缺 id 的 cell、移除悬空的 source/target 引用、补 mxGeometry 的 as 属性。
 * 返回 null 表示无法修复。
 */
export async function extractAndFixXml(content: string): Promise<string | null> {
	const text = content.replace(/```[a-z]*\n?/gi, '').trim();

	let fragment = sliceTag(text, 'mxfile');
	if (!fragment) {
		fragment = sliceTag(text, 'mxGraphModel');
		if (!fragment) return null;
		fragment = `<mxfile><diagram>${fragment}</diagram></mxfile>`;
	}

	// diagram 内容为压缩格式时先解压
	fragment = await inflateDiagramContent(fragment);

	const doc = new DOMParser().parseFromString(fragment, 'text/xml');
	if (doc.querySelector('parsererror')) return null;

	const model = doc.querySelector('mxfile mxGraphModel') || doc.querySelector('mxGraphModel');
	const root = model?.querySelector('root');
	if (!model || !root) return null;

	// 规范根 cell：id=0 存在则去掉 parent，否则补建；id=1 存在则强制 parent="0"，否则补建
	const cell0 = root.querySelector('mxCell[id="0"]');
	if (cell0) {
		cell0.removeAttribute('parent');
	} else {
		const c0 = doc.createElement('mxCell');
		c0.setAttribute('id', '0');
		root.prepend(c0);
	}
	const cell1 = root.querySelector('mxCell[id="1"]');
	if (cell1) {
		cell1.setAttribute('parent', '0');
	} else {
		const c1 = doc.createElement('mxCell');
		c1.setAttribute('id', '1');
		c1.setAttribute('parent', '0');
		root.insertBefore(c1, root.children[1] || null);
	}

	// 修复 parent 自引用（如 id="1" parent="1" 会隐藏整个图层，官方 repair pass 同款处理）
	for (const cell of Array.from(root.querySelectorAll('mxCell'))) {
		const id = cell.getAttribute('id');
		if (id && id !== '0' && cell.getAttribute('parent') === id) {
			cell.setAttribute('parent', '0');
		}
	}

	// 顶点/边缺 parent 属性时补 "1"（缺 parent 的 cell 不渲染）
	for (const cell of Array.from(root.querySelectorAll('mxCell'))) {
		if ((cell.getAttribute('vertex') === '1' || cell.getAttribute('edge') === '1') && !cell.getAttribute('parent')) {
			cell.setAttribute('parent', '1');
		}
	}

	// 去掉重复 id / 缺 id 的 cell（首见保留），同时收集有效 id 集合
	const validIds = new Set<string>();
	for (const cell of Array.from(root.querySelectorAll('mxCell'))) {
		const id = cell.getAttribute('id');
		if (!id || validIds.has(id)) {
			cell.remove();
			continue;
		}
		validIds.add(id);
	}

	// 修复边：source/target 指向不存在的 cell 时移除引用（无端点的边 drawio 仍可渲染）
	for (const cell of Array.from(root.querySelectorAll('mxCell'))) {
		if (cell.getAttribute('edge') !== '1') continue;
		for (const ref of ['source', 'target']) {
			const id = cell.getAttribute(ref);
			if (id && !validIds.has(id)) {
				cell.removeAttribute(ref);
			}
		}
	}

	// 修复几何：缺 as 属性时补上
	for (const geo of Array.from(root.querySelectorAll('mxCell > mxGeometry'))) {
		if (!geo.getAttribute('as')) {
			geo.setAttribute('as', 'geometry');
		}
	}

	// 除根 cell 外必须还有实际内容
	if (root.querySelectorAll('mxCell').length <= 2) return null;

	return new XMLSerializer().serializeToString(doc);
}

/** 统计 <diagram> 页数；解析失败按单页处理 */
export function countDiagramPages(fragment: string): number {
	if (!fragment || !fragment.includes('<diagram')) return 1;
	const doc = new DOMParser().parseFromString(fragment, 'text/xml');
	if (doc.querySelector('parsererror')) return 1;
	return Math.max(doc.querySelectorAll('diagram').length, 1);
}

/**
 * 多页保护：AI 只产出单页 mxfile，直接 load 会整文件替换、丢掉其余页。
 * 这里把 AI 结果合入原文档第一页，其余页原样保留；任一侧解析失败返回 null（调用方退回整图替换）。
 */
export function replaceFirstDiagramPage(originalXml: string, newXml: string): string | null {
	try {
		const origDoc = new DOMParser().parseFromString(originalXml, 'text/xml');
		const newDoc = new DOMParser().parseFromString(newXml, 'text/xml');
		if (origDoc.querySelector('parsererror') || newDoc.querySelector('parsererror')) return null;

		const origPages = origDoc.querySelectorAll('diagram');
		const newModel = newDoc.querySelector('mxfile mxGraphModel') || newDoc.querySelector('mxGraphModel');
		if (origPages.length < 2 || !newModel) return null;

		const firstPage = origPages[0];
		while (firstPage.firstChild) firstPage.removeChild(firstPage.firstChild);
		firstPage.appendChild(origDoc.importNode(newModel, true));
		return new XMLSerializer().serializeToString(origDoc);
	}
	catch {
		return null;
	}
}
