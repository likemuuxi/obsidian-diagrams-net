import { App, MarkdownView, Modal, TFile, Vault, View, Notice, setIcon } from 'obsidian';
import { t } from './lang/helpers';
import { DiagramsEditor } from './diagramsEditor';
import { AiChatMessage, AiProgressFn, buildHighlightOverlay, countDiagramPages, describeDiagramXml, diffChangedCellIds, formatTokenUsage, generateDiagramXml, HIGHLIGHT_STYLE, inflateDiagramContent, isAIConfigured, replaceFirstDiagramPage } from './ai';
import { RenameModal } from './rename';
import { DiagramsSettings } from "./settings";
import { HistoryEntry, loadHistory, refreshTempSnapshot, saveHistorySnapshot } from './diagram-history';

// 撤销到"空画布"时使用的最小合法 mxfile
const BLANK_MXFILE = '<mxfile><diagram><mxGraphModel><root><mxCell id="0"/><mxCell id="1" parent="0"/></root></mxGraphModel></diagram></mxfile>';

export interface DiagramsHostOptions {
    fileInfo: { basename: string, svgPath: string, xmlPath: string, diagramExists: boolean },
    ui: string,
    settings: DiagramsSettings,
    pluginDir: string,
    /** modal：保存后插入当前笔记并关闭；tab：仅落盘，不插入、不关闭 */
    mode: 'modal' | 'tab',
    /** modal 模式的插入目标（当前 Markdown 视图） */
    hostView?: View | null,
    onSaveSettings?: () => Promise<void>,
    initialPrompt?: string,
    /** 创建保存时重命名成功后回调（标签页据此更新标题） */
    onRenamed?: (basename: string) => void,
    /** 关闭宿主：modal 关闭弹窗 / tab 卸载标签页 */
    onExit: () => void
}

/** 图表编辑器主体（画布 + AI 面板）：可挂在 Modal 上（插入流），也可挂在标签页视图上（创建流） */
export class DiagramsEditorHost {
    fileName: string;
    svgPath: string;
    xmlPath: string;
    diagramExists: boolean;
    hostView: View | null;
    vault: Vault;
    ui: string;
    settings: DiagramsSettings;
    mode: 'modal' | 'tab';
    private app: App;
    private onExit: () => void;
    private onRenamed: ((basename: string) => void) | null = null;
    private editor: DiagramsEditor | null = null;
    private xmlData: string | null = null;
    // AI 对话面板状态
    private currentXml: string | null = null; // 画布最新 XML（初始数据 / AI 结果 / 手动编辑的 autosave 上报）
    private panelEl: HTMLElement | null = null;
    private historyEl: HTMLElement | null = null;
    private promptInput: HTMLTextAreaElement | null = null;
    private sendBtn: HTMLButtonElement | null = null;
    // 多轮对话记忆（仅存用户指令与简短确认，不回传 XML，控制 token）
    private aiHistory: AiChatMessage[] = [];
    private lastPrompt: string | null = null;
    // AI / 模板应用前的画布快照栈：reloadXml 会重置 drawio 的 undo 栈，靠这里实现"撤销"；
    // aiTurn 标记该快照是否来自 AI 一轮（撤销时需同步移除对话记忆）
    private undoStack: Array<{ xml: string | null; aiTurn: boolean }> = [];
    // 最新一条成功状态消息里的操作按钮（撤销 / 重新生成），新一轮开始时移除
    private lastStatusActions: HTMLElement | null = null;
    private historyBtn: HTMLButtonElement | null = null;
    // 版本历史（P6）：持久化快照的插件目录
    private pluginDir: string;
    // P7：从笔记/选中文本生成图时预填 AI 输入框的内容
    private initialPrompt: string | null;
    // P9：粘贴/拖入的待发送图片（data URL），随下一次请求发给 vision 模型
    private pendingImage: string | null = null;
    private imagePreviewEl: HTMLElement | null = null;
    // 变更高亮：merge 合并高亮文档后的还原定时器；active 期间忽略携带高亮样式的 autosave 上报
    private highlightTimer: number | null = null;
    private highlightActive = false;
    // 个人模板库（P10）：模板 chip 容器与设置持久化回调
    private templateChipsEl: HTMLElement | null = null;
    private onSaveSettings: (() => Promise<void>) | null = null;
    // 编辑器 UI 挂载容器（Modal 的 contentEl 或标签页视图的 contentEl）
    private container: HTMLElement | null = null;

    constructor(app: App, opts: DiagramsHostOptions) {
        this.app = app;
        this.vault = app.vault;
        this.fileName = opts.fileInfo.basename;
        this.svgPath = opts.fileInfo.svgPath;
        this.xmlPath = opts.fileInfo.xmlPath;
        this.diagramExists = opts.fileInfo.diagramExists;
        this.hostView = opts.hostView ?? null;
        this.ui = opts.ui;
        this.settings = opts.settings;
        this.mode = opts.mode;
        this.pluginDir = opts.pluginDir;
        this.onSaveSettings = opts.onSaveSettings ?? null;
        this.initialPrompt = opts.initialPrompt ?? null;
        this.onRenamed = opts.onRenamed ?? null;
        this.onExit = opts.onExit;
    }

    /** 当前图表信息（标签页视图序列化状态用） */
    getFileInfo() {
        return { basename: this.fileName, svgPath: this.svgPath, xmlPath: this.xmlPath, diagramExists: this.diagramExists };
    }


    /** 构建编辑器 UI；container 为宿主提供的内容容器（Modal contentEl / 标签页 view-content） */
    async open(container: HTMLElement) {
        this.container = container;
        container.addClass('diagrams-editor-content');

        // 左侧画布区域（iframe 挂载点）
        const editorArea = container.createDiv('diagrams-editor-area');

        // 读取已有图表数据（新建时跳过）
        if (this.diagramExists) {
            const xmlFile = this.vault.getAbstractFileByPath(this.xmlPath);
            if (!(xmlFile instanceof TFile)) {
                new Notice(t('DIAGRAM_DATA_MISSING'));
                this.onExit();
                return;
            }
            this.xmlData = await this.vault.cachedRead(xmlFile);
            this.currentXml = this.xmlData;
        }

        this.editor = new DiagramsEditor(editorArea, this.ui, this.settings.embedUrl, {
            onSave: (msg) => this.handleSaveAndExit(msg),
            onExit: () => this.onExit(),
            getData: () => this.xmlData,
            onXmlUpdate: (xml) => {
                // 变更高亮期间画布 autosave 会带出 HIGHLIGHT_STYLE 临时样式，忽略之，避免污染 currentXml
                if (this.highlightActive && xml.includes(HIGHLIGHT_STYLE)) return;
                this.currentXml = xml;
            },
        });
        this.editor.start();

        // 右侧 AI 对话面板
        this.buildAiPanel(container);

        // 从笔记/选中文本打开时预填输入框，用户可补充指令后再发送
        if (this.initialPrompt && this.promptInput) {
            this.promptInput.value = this.initialPrompt;
        }
    }

    /** 卸载编辑器（解绑全局监听、销毁 iframe），由宿主在关闭时调用 */
    destroy() {
        if (this.highlightTimer !== null) {
            window.clearTimeout(this.highlightTimer);
            this.highlightTimer = null;
        }
        this.highlightActive = false;
        this.editor?.stop();
        this.editor = null;
        this.container = null;
    }

    // ---------- AI 对话面板 ----------

    private buildAiPanel(parent: HTMLElement) {
        const panel = parent.createDiv('diagrams-ai-panel');

        // header：右侧操作区（图转文字 + 历史 + 折叠），贴面板最右
        const header = panel.createDiv('diagrams-ai-header');
        const headerActions = header.createDiv('diagrams-ai-header-actions');
        // 图→文字按钮：把当前画布逆向生成 Markdown 说明
        const describeBtn = headerActions.createEl('button', {
            cls: 'diagrams-ai-header-icon',
            attr: { 'aria-label': t('AI_DESCRIBE') }
        });
        setIcon(describeBtn, 'file-text');
        describeBtn.onclick = () => { void this.runDescribe(); };
        // 版本历史按钮：弹窗展示快照列表
        this.historyBtn = headerActions.createEl('button', {
            cls: 'diagrams-ai-header-icon',
            attr: { 'aria-label': t('AI_TAB_HISTORY') }
        });
        setIcon(this.historyBtn, 'history');
        this.historyBtn.onclick = () => this.openHistoryModal();
        // 折叠按钮：chevrons-right 图标，与其他图标按钮同尺寸、居中对齐
        const collapseBtn = headerActions.createEl('button', {
            cls: 'diagrams-ai-header-icon',
            attr: { 'aria-label': t('AI_PANEL_COLLAPSE') }
        });
        setIcon(collapseBtn, 'chevrons-right');
        collapseBtn.onclick = () => this.toggleAiPanel(false);
        this.panelEl = panel;

        // 对话视图
        const chatView = panel.createDiv('diagrams-ai-view');
        this.historyEl = chatView.createDiv('diagrams-ai-history');

        // 常用图模板快捷键：点击把起手 prompt 填入输入框
        this.buildTemplateChips(chatView);

        // 输入区：输入框与发送按钮合并为一个整体（按钮内嵌在输入框右下角）
        const inputArea = chatView.createDiv('diagrams-ai-input');
        // 图片预览（P9）：粘贴/拖入图片后显示缩略图，可移除
        const imagePreview = inputArea.createDiv('diagrams-ai-image-preview');
        imagePreview.style.display = 'none';
        this.imagePreviewEl = imagePreview;
        const promptWrap = inputArea.createDiv('diagrams-ai-prompt-wrap');
        this.promptInput = promptWrap.createEl('textarea', {
            cls: 'diagrams-ai-prompt',
            attr: { rows: '3', placeholder: t('AI_PANEL_PLACEHOLDER') }
        });
        this.sendBtn = promptWrap.createEl('button', {
            cls: 'diagrams-ai-send',
            attr: { 'aria-label': `${t('AI_GENERATE')} (Enter)` }
        });
        setIcon(this.sendBtn, 'send');
        this.sendBtn.onclick = () => { void this.handleAiSend(); };
        // Enter 发送（Ctrl/Cmd+Enter 同样生效），Shift+Enter 换行；isComposing 避开中文输入法组词确认
        this.promptInput.addEventListener('keydown', (evt) => {
            if (evt.key === 'Enter' && !evt.shiftKey && !evt.isComposing) {
                evt.preventDefault();
                void this.handleAiSend();
            }
        });
        // 粘贴图片（P9）：剪贴板含图片时读取为 data URL 附到下一次请求
        this.promptInput.addEventListener('paste', (evt) => {
            const items = evt.clipboardData?.items;
            if (!items) return;
            for (const item of Array.from(items)) {
                if (item.type.startsWith('image/')) {
                    const file = item.getAsFile();
                    if (!file) continue;
                    evt.preventDefault();
                    void this.attachImage(file);
                    return;
                }
            }
        });
        // 拖入图片（P9）：拖到输入区即附图
        inputArea.addEventListener('dragover', (evt) => { evt.preventDefault(); });
        inputArea.addEventListener('drop', (evt) => {
            evt.preventDefault();
            const file = evt.dataTransfer?.files?.[0];
            if (file && file.type.startsWith('image/')) void this.attachImage(file);
        });

        // 面板收起后塌缩为右缘窄条，点击图标重新展开（与折叠按钮同在右侧边缘）
        const rail = panel.createDiv('diagrams-ai-rail');
        setIcon(rail, 'sparkles');
        rail.setAttr('aria-label', t('AI_PANEL_EXPAND'));
        rail.onclick = () => this.toggleAiPanel(true);

        // 左缘拖拽条：拖动调整面板宽度
        const resizer = panel.createDiv('diagrams-ai-resizer');
        resizer.setAttr('aria-label', t('AI_PANEL_RESIZE'));
        this.bindPanelResize(resizer);
    }

    /** 拖拽调整面板宽度；用户设置以内联样式生效 */
    private bindPanelResize(handle: HTMLElement) {
        handle.addEventListener('pointerdown', (evt: PointerEvent) => {
            if (evt.button !== 0) return;
            evt.preventDefault();
            const panel = this.panelEl;
            const content = this.container;
            if (!panel || !content) return;
            const startX = evt.clientX;
            const startWidth = panel.getBoundingClientRect().width;
            // 指针捕获：光标移到 iframe 上时事件仍派发给本元素，保证松开能收到、不卡死
            handle.setPointerCapture(evt.pointerId);
            const docEl = document.documentElement;
            docEl.style.cursor = 'col-resize';
            docEl.style.userSelect = 'none';
            // 双保险：拖拽期间让 iframe 指针事件穿透
            content.addClass('is-resizing');

            // rAF 合帧：pointermove 频率可能高于刷新率，每帧只写一次样式避免重复布局
            let pendingWidth = -1;
            let rafId = 0;
            const applyWidth = () => {
                rafId = 0;
                if (pendingWidth < 0) return;
                panel.style.width = `${pendingWidth}px`;
                panel.style.flexBasis = `${pendingWidth}px`;
                pendingWidth = -1;
            };

            const onMove = (e: PointerEvent) => {
                // 面板贴右侧：向左拖增宽，向右拖变窄
                pendingWidth = Math.min(Math.max(startWidth + (startX - e.clientX), 260), Math.floor(window.innerWidth * 0.8));
                if (!rafId) rafId = requestAnimationFrame(applyWidth);
            };
            const onUp = () => {
                docEl.style.cursor = '';
                docEl.style.userSelect = '';
                content.removeClass('is-resizing');
                handle.removeEventListener('pointermove', onMove);
                handle.removeEventListener('pointerup', onUp);
                handle.removeEventListener('pointercancel', onUp);
            };
            handle.addEventListener('pointermove', onMove);
            handle.addEventListener('pointerup', onUp);
            handle.addEventListener('pointercancel', onUp);
        });
    }

    /** 打开版本历史弹窗：点击条目把该快照恢复到画布 */
    private openHistoryModal() {
        new HistoryModal(this.app, this.vault, this.pluginDir, this.xmlPath, (entry) => this.restoreHistoryEntry(entry)).open();
    }

    /**
     * 恢复历史快照：跳走前把当前画布刷成唯一的临时快照（temp）。
     * 恢复目标是 temp 时等价于 A/B 状态交换，来回跳转永远可回退，temp 不堆积。
     */
    private restoreHistoryEntry(entry: HistoryEntry) {
        void refreshTempSnapshot(this.vault, this.pluginDir, this.xmlPath, this.currentXml, t('AI_HISTORY_BEFORE_RESTORE'));
        this.applyProgrammaticXml(entry.xml, this.currentXml, false);
        new Notice(t('AI_HISTORY_RESTORED'));
    }

    /**
     * 把外部产出的 XML（AI 生成 / 模板载入）应用到画布：
     * 多页文件先合并保护其余页，再压入撤销快照栈并刷新画布。
     * changedIds 非空时在应用后高亮这些 cell 数秒，提示 AI 改了哪里。
     */
    private applyProgrammaticXml(xml: string, snapshot: string | null, aiTurn: boolean, changedIds?: string[], sourcePrompt?: string) {
        let applied = xml;
        let snapshotForStack = snapshot;
        const pages = countDiagramPages(this.xmlData ?? '');
        if (pages > 1) {
            // autosave 上报的是当前页单页内容；撤销快照需合回完整多页文档，撤销时才不丢其他页
            if (snapshot) {
                const mergedSnap = replaceFirstDiagramPage(this.xmlData!, snapshot);
                if (mergedSnap) snapshotForStack = mergedSnap;
            } else {
                snapshotForStack = this.xmlData;
            }
            const merged = replaceFirstDiagramPage(this.xmlData!, xml);
            if (merged) {
                applied = merged;
                new Notice(t('AI_MULTI_PAGE_KEPT').replace('{0}', String(pages - 1)));
            }
        }
        this.disableLastStatusActions();
        this.undoStack.push({ xml: snapshotForStack, aiTurn });
        if (this.undoStack.length > 20) this.undoStack.shift();
        // AI 轮且画布非空：应用前把快照持久化到版本历史（失败仅警告；空画布快照无意义，跳过）
        if (aiTurn && sourcePrompt && snapshotForStack) {
            void saveHistorySnapshot(this.vault, this.pluginDir, this.xmlPath, snapshotForStack, sourcePrompt);
        }
        this.currentXml = applied;
        this.editor?.reloadXml(applied);
        if (changedIds && changedIds.length) this.showChangeHighlight(applied, changedIds);
    }

    /**
     * 变更高亮：用 merge 动作把"带橙色描边的完整文档"差异合并进画布（只改命中 cell 的样式，
     * 不整图刷新），数秒后合并原始文档还原样式。合并触发的 autosave 会带上高亮样式，
     * onXmlUpdate 已按 HIGHLIGHT_STYLE 过滤，currentXml 不会被污染。
     */
    private showChangeHighlight(appliedXml: string, cellIds: string[]) {
        if (this.highlightTimer !== null) {
            window.clearTimeout(this.highlightTimer);
            this.highlightTimer = null;
        }
        const overlay = buildHighlightOverlay(appliedXml, cellIds, true);
        if (!overlay) return; // 没有可高亮的 cell，整轮跳过
        this.highlightActive = true;
        this.editor?.mergeXml(overlay);
        this.highlightTimer = window.setTimeout(() => {
            this.highlightTimer = null;
            // 还原：合并原始文档，diff 会移除高亮描边（原文档本就不含描边时直接发原文档）。
            // 此时仍处于 highlightActive，本轮还原触发的 autosave 若带描边同样被忽略
            const restore = buildHighlightOverlay(appliedXml, cellIds, false) ?? appliedXml;
            this.editor?.mergeXml(restore);
            // 再留一小段缓冲，等还原后的 autosave（带原始样式）上报完再解除过滤
            window.setTimeout(() => { this.highlightActive = false; }, 1000);
        }, 3000);
    }

    private toggleAiPanel(show: boolean) {
        // 收起时面板塌缩为窄条而非整个隐藏，展开入口保持在右侧同一边缘
        this.panelEl?.toggleClass('is-collapsed', !show);
    }

    private async handleAiSend() {
        const input = this.promptInput;
        if (!input) return;
        const prompt = input.value.trim();
        if (!prompt) return;
        await this.runAiGeneration(prompt);
    }

    /** 读取图片文件为 data URL 挂到下一次请求（P9）；超过 5MB 拒绝 */
    private async attachImage(file: File) {
        if (file.size > 5 * 1024 * 1024) {
            new Notice(t('AI_IMAGE_TOO_LARGE'));
            return;
        }
        const dataUrl = await new Promise<string>((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(String(reader.result));
            reader.onerror = () => reject(reader.error);
            reader.readAsDataURL(file);
        }).catch((): string | null => null);
        if (!dataUrl) {
            new Notice(t('AI_IMAGE_INVALID'));
            return;
        }
        this.pendingImage = dataUrl;
        this.renderImagePreview();
    }

    /** 渲染/隐藏待发送图片的缩略图预览 */
    private renderImagePreview() {
        const el = this.imagePreviewEl;
        if (!el) return;
        el.empty();
        if (!this.pendingImage) {
            el.style.display = 'none';
            return;
        }
        el.style.display = '';
        const img = el.createEl('img', { attr: { src: this.pendingImage, alt: '' } });
        img.draggable = false;
        const removeBtn = el.createEl('button', {
            cls: 'diagrams-ai-image-remove',
            attr: { 'aria-label': t('AI_IMAGE_REMOVE') }
        });
        removeBtn.textContent = '×';
        removeBtn.onclick = () => {
            this.pendingImage = null;
            this.renderImagePreview();
        };
    }

    /** 流式进度回调工厂：节流 ~150ms 刷新一次，显示思考/生成阶段的累计字符数 */
    private makeProgressUpdater(statusEl: HTMLElement): AiProgressFn {
        let progressPhase = '';
        let progressAt = 0;
        return (phase, chars) => {
            const now = Date.now();
            if (phase === progressPhase && now - progressAt < 150) return;
            progressPhase = phase;
            progressAt = now;
            const label = t(phase === 'thinking' ? 'AI_THINKING' : 'AI_GENERATING');
            statusEl.textContent = `${label} (${chars >= 1000 ? `${(chars / 1000).toFixed(1)}k` : chars})`;
        };
    }

    /** 执行一轮 AI 生成：追加对话记录、调模型、应用结果并挂上撤销/重新生成按钮 */
    private async runAiGeneration(prompt: string) {
        const input = this.promptInput;
        const sendBtn = this.sendBtn;
        if (!input || !sendBtn) return;

        if (!isAIConfigured(this.settings)) {
            new Notice(t('AI_NOT_CONFIGURED'));
            return;
        }

        this.lastPrompt = prompt;
        this.disableLastStatusActions();
        input.value = '';
        sendBtn.disabled = true;
        this.appendAiMessage(prompt, 'user');
        const statusEl = this.appendAiMessage(t('AI_GENERATING'), 'status');

        try {
            // 画布已有内容时把当前 XML 一并交给 AI，实现"在现状上修改"；同时回传多轮历史
            const priorHistory = this.aiHistory.slice();
            const snapshotBefore = this.currentXml;
            const onProgress = this.makeProgressUpdater(statusEl);
            const { xml, changedIds: editIds, reasoning, usage } = await generateDiagramXml(prompt, this.settings, snapshotBefore ?? undefined, priorHistory, this.pendingImage ?? undefined, onProgress);
            // 发送成功后清掉附图（失败保留，便于直接重试）
            if (this.pendingImage) {
                this.pendingImage = null;
                this.renderImagePreview();
            }
            // 增量编辑自带命中 cell；全量重画时对比前后快照算出变化集
            const changedIds = editIds ?? await diffChangedCellIds(snapshotBefore, xml);
            // 推理模型：在状态消息前插入可折叠的思考过程块
            if (reasoning && this.historyEl && statusEl.parentElement === this.historyEl) {
                this.historyEl.insertBefore(this.buildReasoningBlock(reasoning), statusEl);
            }
            this.applyProgrammaticXml(xml, snapshotBefore, true, changedIds, prompt);
            // 生成成功才计入对话记忆（assistant 只存简短确认，不重复回传 XML）
            this.aiHistory.push({ role: 'user', content: prompt }, { role: 'assistant', content: 'Diagram updated accordingly.' });
            if (this.aiHistory.length > 10) this.aiHistory = this.aiHistory.slice(-10);
            const usageText = formatTokenUsage(usage);
            statusEl.textContent = usageText ? `${t('AI_PANEL_APPLIED')} · ${usageText}` : t('AI_PANEL_APPLIED');
            statusEl.addClass('ok');
            this.attachStatusActions(statusEl);
        }
        catch (e: any) {
            statusEl.textContent = e?.message || String(e);
            statusEl.addClass('err');
        }
        finally {
            sendBtn.disabled = false;
            input.focus();
        }
    }

    /** 图→文字逆向生成：把当前画布交给模型产出 Markdown 说明，结果展示在对话区，可复制或插入笔记 */
    private async runDescribe() {
        if (!isAIConfigured(this.settings)) {
            new Notice(t('AI_NOT_CONFIGURED'));
            return;
        }
        if (!this.currentXml || await this.isCanvasEmpty(this.currentXml)) {
            new Notice(t('AI_DESCRIBE_EMPTY_CANVAS'));
            return;
        }
        this.disableLastStatusActions();
        const statusEl = this.appendAiMessage(t('AI_DESCRIBING'), 'status');
        try {
            const { text, usage } = await describeDiagramXml(this.currentXml, this.settings, this.makeProgressUpdater(statusEl));
            const usageText = formatTokenUsage(usage);
            statusEl.textContent = usageText ? `${t('AI_DESCRIBE_DONE')} · ${usageText}` : t('AI_DESCRIBE_DONE');
            statusEl.addClass('ok');
            // 说明正文：可选中复制的 Markdown 源文本块
            const body = statusEl.createDiv('diagrams-ai-desc-text');
            body.textContent = text;
            // 操作：复制 / 插入到打开本图的笔记（tab 模式无宿主编辑器时仅复制）
            const actions = statusEl.createDiv('diagrams-ai-actions');
            const copyBtn = actions.createEl('button', {
                cls: 'diagrams-ai-action-btn',
                attr: { 'aria-label': t('AI_DESCRIBE_COPY') }
            });
            setIcon(copyBtn, 'copy');
            copyBtn.onclick = () => {
                void navigator.clipboard.writeText(text).then(() => new Notice(t('AI_DESCRIBE_COPIED')));
            };
            const insertBtn = actions.createEl('button', {
                cls: 'diagrams-ai-action-btn',
                attr: { 'aria-label': t('AI_DESCRIBE_INSERT') }
            });
            setIcon(insertBtn, 'clipboard-paste');
            insertBtn.onclick = () => this.insertTextToHostNote(text);
            this.lastStatusActions = actions;
            this.historyEl?.scrollTo({ top: this.historyEl.scrollHeight });
        }
        catch (e: any) {
            statusEl.textContent = e?.message || String(e);
            statusEl.addClass('err');
        }
    }

    /** 把文本插入宿主笔记编辑器的光标处（无宿主编辑器时提示） */
    private insertTextToHostNote(text: string) {
        // @ts-ignore: Type not documented.
        const editor = this.hostView?.editor;
        if (!editor) {
            new Notice(t('NO_ACTIVE_EDITOR'));
            return;
        }
        const cursor = editor.getCursor();
        editor.replaceRange(`\n${text}\n`, cursor);
    }

    /** 成功状态消息下挂"撤销 / 重新生成"操作按钮 */
    private attachStatusActions(statusEl: HTMLElement) {
        const actions = statusEl.createDiv('diagrams-ai-actions');
        const undoBtn = actions.createEl('button', {
            cls: 'diagrams-ai-action-btn',
            attr: { 'aria-label': t('AI_UNDO') }
        });
        setIcon(undoBtn, 'undo-2');
        undoBtn.onclick = () => this.undoLastChange(statusEl);
        const regenBtn = actions.createEl('button', {
            cls: 'diagrams-ai-action-btn',
            attr: { 'aria-label': t('AI_REGENERATE') }
        });
        setIcon(regenBtn, 'refresh-cw');
        regenBtn.onclick = () => { void this.regenerateLast(statusEl); };
        this.lastStatusActions = actions;
    }

    private disableLastStatusActions() {
        this.lastStatusActions?.remove();
        this.lastStatusActions = null;
    }

    /** 撤销最近一次 AI/模板应用：从快照栈恢复画布，并同步修正对话记忆 */
    private undoLastChange(statusEl: HTMLElement) {
        const entry = this.undoStack.pop();
        if (!entry) return;
        this.currentXml = entry.xml;
        this.editor?.reloadXml(entry.xml ?? BLANK_MXFILE);
        // 被撤销的 AI 一轮从对话记忆中移除，保持历史与画布一致
        if (entry.aiTurn && this.aiHistory.length >= 2 && this.aiHistory[this.aiHistory.length - 1].role === 'assistant') {
            this.aiHistory.length -= 2;
        }
        statusEl.textContent = t('AI_UNDONE');
        this.disableLastStatusActions();
    }

    /** 重新生成：先恢复到生成前的画布，再用同一 prompt 重试，避免在坏结果上继续修改 */
    private async regenerateLast(statusEl: HTMLElement) {
        const prompt = this.lastPrompt;
        if (!prompt) return;
        const entry = this.undoStack.pop();
        if (entry) {
            this.currentXml = entry.xml;
            this.editor?.reloadXml(entry.xml ?? BLANK_MXFILE);
        }
        statusEl.textContent = t('AI_REGENERATING');
        this.disableLastStatusActions();
        await this.runAiGeneration(prompt);
    }

    /** 常用图模板：内置 Quick Examples + 个人模板库（P10）。内置 chip 填入起手 prompt，个人 chip 直接载入 XML */
    private buildTemplateChips(parent: HTMLElement) {
        this.templateChipsEl = parent.createDiv('diagrams-ai-templates');
        this.renderTemplateChips();
    }

    /** 重建模板 chip 行：内置模板 → 个人模板（带删除 ×）→ 存为模板入口 */
    private renderTemplateChips() {
        const chips = this.templateChipsEl;
        if (!chips) return;
        chips.empty();
        const templates: Array<[string, string]> = [
            [t('AI_TPL_FLOWCHART'), t('AI_TPL_FLOWCHART_PROMPT')],
            [t('AI_TPL_SWIMLANE'), t('AI_TPL_SWIMLANE_PROMPT')],
            [t('AI_TPL_SEQUENCE'), t('AI_TPL_SEQUENCE_PROMPT')],
            [t('AI_TPL_ER'), t('AI_TPL_ER_PROMPT')],
            [t('AI_TPL_CLASS'), t('AI_TPL_CLASS_PROMPT')],
            [t('AI_TPL_MINDMAP'), t('AI_TPL_MINDMAP_PROMPT')],
        ];
        for (const [label, promptText] of templates) {
            const chip = chips.createEl('button', { text: label, cls: 'diagrams-ai-chip' });
            chip.onclick = () => {
                if (!this.promptInput) return;
                this.promptInput.value = promptText;
                this.promptInput.focus();
                // 光标落在末尾，方便接着描述
                this.promptInput.setSelectionRange(promptText.length, promptText.length);
            };
        }
        // 个人模板：点击把存的 XML 载入画布（撤销栈可回退），chip 内嵌 × 删除
        const custom = this.settings.customTemplates ?? [];
        for (const tpl of custom) {
            const chip = chips.createEl('button', { cls: 'diagrams-ai-chip is-custom', attr: { 'aria-label': t('AI_TPL_LOAD') } });
            chip.createSpan({ text: tpl.name });
            const del = chip.createSpan({ text: '×', cls: 'diagrams-ai-chip-delete' });
            del.setAttr('aria-label', t('AI_TPL_DELETE'));
            del.onclick = (evt) => {
                evt.stopPropagation();
                void this.deleteCustomTemplate(tpl.name);
            };
            chip.onclick = () => this.loadCustomTemplate(tpl.name, tpl.xml);
        }
        // 存为模板入口：把当前画布命名保存进插件 data
        const addBtn = chips.createEl('button', { text: '+', cls: 'diagrams-ai-chip diagrams-ai-chip-add' });
        addBtn.setAttr('aria-label', t('AI_TPL_SAVE'));
        addBtn.onclick = () => { void this.saveCurrentAsTemplate(); };
    }

    /** 判断画布是否有实际内容（除默认根节点 0/1 外存在任意 cell）；压缩格式（磁盘 mxfile）先解压再判断，否则会误判为空 */
    private async isCanvasEmpty(xml: string): Promise<boolean> {
        const plain = await inflateDiagramContent(xml);
        const ids = Array.from(plain.matchAll(/<mxCell[^>]*\bid="([^"]+)"/g)).map(m => m[1]);
        return ids.filter(id => id !== '0' && id !== '1').length === 0;
    }

    /** 把当前画布 XML 存为个人模板（P10）：弹窗命名后写入插件 data */
    private async saveCurrentAsTemplate() {
        if (!this.currentXml || await this.isCanvasEmpty(this.currentXml)) {
            new Notice(t('AI_TPL_EMPTY_CANVAS'));
            return;
        }
        const xml = this.currentXml;
        new TemplateNameModal(this.app, (name) => {
            const trimmed = (name ?? '').trim().slice(0, 40);
            if (!trimmed) return;
            const list = this.settings.customTemplates ?? (this.settings.customTemplates = []);
            // 上限 30 条，超出淘汰最早的
            if (list.length >= 30) list.shift();
            list.push({ name: trimmed, xml });
            void this.onSaveSettings?.().then(() => {
                new Notice(t('AI_TPL_SAVED').replace('{0}', trimmed));
                this.renderTemplateChips();
            });
        }).open();
    }

    private async deleteCustomTemplate(name: string) {
        const list = this.settings.customTemplates ?? [];
        const idx = list.findIndex(tp => tp.name === name);
        if (idx < 0) return;
        list.splice(idx, 1);
        await this.onSaveSettings?.();
        new Notice(t('AI_TPL_DELETED').replace('{0}', name));
        this.renderTemplateChips();
    }

    private loadCustomTemplate(name: string, xml: string) {
        // 载入前把当前画布压入撤销栈，误载入可一键撤销；非 AI 轮，不写版本历史
        this.applyProgrammaticXml(xml, this.currentXml, false);
        new Notice(t('AI_TPL_LOADED').replace('{0}', name));
    }

    private appendAiMessage(text: string, kind: 'user' | 'status'): HTMLElement {
        const history = this.historyEl;
        const el = document.createElement('div');
        el.className = `diagrams-ai-msg ${kind}`;
        el.textContent = text;
        history?.appendChild(el);
        history?.scrollTo({ top: history.scrollHeight });
        return el;
    }

    /** 推理模型的思考过程折叠块（<details>），默认收起 */
    private buildReasoningBlock(reasoning: string): HTMLElement {
        const details = document.createElement('details');
        details.className = 'diagrams-ai-reasoning';
        const summary = document.createElement('summary');
        summary.textContent = t('AI_REASONING');
        details.appendChild(summary);
        const body = document.createElement('div');
        body.className = 'diagrams-ai-reasoning-body';
        body.textContent = reasoning;
        details.appendChild(body);
        return details;
    }

    // 必须等写盘（以及可选的重命名）完成后才能关闭/刷新，否则存在竞态
    private async handleSaveAndExit(msg: any) {
        await this.saveData(msg);
        if (this.diagramExists) {
            await this.refreshMarkdownViews();
        }
        if (this.mode === 'tab') {
            // 创建流：仅落盘不插入笔记；保存并退出 → 关闭标签页
            new Notice(t('DIAGRAM_SAVED'));
            this.onExit();
            return;
        }
        if (!this.diagramExists && !this.settings.createAndRename) {
            this.insertDiagram();
        }
        this.onExit();
    };

    private async saveData(msg: any) {
        const svgBuffer = Buffer.from(msg.data.replace('data:image/svg+xml;base64,', ''), 'base64');
        const svgArrayBuffer = new Uint8Array(svgBuffer).buffer;

        // 保存后同步内存副本，后续多页合并的基线不落后于磁盘
        this.xmlData = msg.xml;

        if (this.diagramExists) {
            // 图表已存在，修改文件
            const svgFile = this.vault.getAbstractFileByPath(this.svgPath);
            const xmlFile = this.vault.getAbstractFileByPath(this.xmlPath);
            if (!(svgFile instanceof TFile && xmlFile instanceof TFile)) {
                return;
            }
            await this.vault.modifyBinary(svgFile, svgArrayBuffer);
            await this.vault.modify(xmlFile, msg.xml);
        } else {
            // 图表不存在，创建新文件
            const svgFile = await this.vault.createBinary(this.svgPath, svgArrayBuffer);
            const xmlFile = await this.vault.create(this.xmlPath, msg.xml);

            if (svgFile instanceof TFile && xmlFile instanceof TFile) {
                // 创建成功后标记已存在：tab 模式保存后不关闭，再次保存需走 modify 而非重复 create
                this.diagramExists = true;
                // 确保文件成功创建后立刻执行重命名
                if (this.settings.createAndRename) {
                    await this.renameFiles(svgFile.path, xmlFile.path);
                }
            }
        }
    };

    private async renameFiles(svgPath: string, xmlPath: string) {
        const newName = await this.promptForNewName(this.fileName);
        // 取消重命名时，按原文件名插入图表（仅插入流；tab 模式已在 handleSaveAndExit 提示保存完成）
        if (!newName || !newName.trim()) {
            if (this.mode === 'modal') this.insertDiagram();
            return;
        }
        const parentPath = this.vault.getAbstractFileByPath(svgPath)?.parent?.path ?? '/';
        const newSvgPath = parentPath === '/' ? `${newName}.svg` : `${parentPath}/${newName}.svg`;
        const newXmlPath = newSvgPath.slice(0, -4) + '.xml';

        const svgFile = this.vault.getAbstractFileByPath(svgPath);
        const xmlFile = this.vault.getAbstractFileByPath(xmlPath);
        if (!(svgFile instanceof TFile && xmlFile instanceof TFile)) {
            if (this.mode === 'modal') this.insertDiagram();
            return;
        }

        try {
            // 先重命名 xml 再重命名 svg，避免 svg 的 rename 事件联动重命名造成冲突
            await this.vault.rename(xmlFile, newXmlPath);
            this.xmlPath = newXmlPath;
            await this.vault.rename(svgFile, newSvgPath);
            this.svgPath = newSvgPath;
            this.fileName = newName;
            // 通知宿主（标签页）更新标题
            this.onRenamed?.(newName);
        } catch (error) {
            new Notice(`${t('RENAME_FAILED')}: ${error}`);
        }
        if (this.mode === 'modal') this.insertDiagram();
    };

    private async refreshMarkdownViews() {
        // 获取处理前滚动条位置百分比
        const view = this.app.workspace.getActiveViewOfType(MarkdownView);
        if (!view) return;
        let scrollPosition: any;
        if (view.getMode() === "preview") {
            scrollPosition = view.previewMode.getScroll();
            // refresh the previewView.
            setTimeout(() => {
                view.previewMode.rerender(true);
            }, 100);
        } else if (view.getMode() === "source") {
            const editor = view.editor;
            const cursor = editor.getCursor();
            const line = editor.getLine(cursor.line);
            const match = line.match(/\[\[.*?\]\]/);
            if (!match) return;
            const modifiedLine = line.replace(/\!\[\[/, '[[');
            editor.replaceRange(modifiedLine, { line: cursor.line, ch: 0 }, { line: cursor.line, ch: line.length });
            setTimeout(() => {
                const finalLine = modifiedLine.replace(/\[\[/, '![[');
                editor.replaceRange(finalLine, { line: cursor.line, ch: 0 }, { line: cursor.line, ch: modifiedLine.length });
            }, 100);
        }

        // 处理后滚动回去
        setTimeout(() => {
            const editView = view.currentMode;
            editView.applyScroll(scrollPosition);
        }, 500);
    }

    private promptForNewName(defaultName: string): Promise<string | null> {
        return new Promise((resolve) => {
            const modal = new RenameModal(this.app, defaultName, (newName) => {
                resolve(newName);
            });
            modal.open();
        });
    };

    private insertDiagram() {
        // @ts-ignore: Type not documented.
        const editor = this.hostView?.editor;
        if (!editor) {
            new Notice(t('NO_ACTIVE_EDITOR'));
            return;
        }
        const cursor = editor.getCursor();
        editor.replaceRange(`![[${this.svgPath}]]`, cursor);
    }

}

/** 版本历史弹窗（P6）：列出 AI 修改前的持久化快照（新→旧），点击恢复后关闭 */
class HistoryModal extends Modal {
    private vault: Vault;
    private pluginDir: string;
    private xmlPath: string;
    private onRestore: (entry: HistoryEntry) => void;

    constructor(app: App, vault: Vault, pluginDir: string, xmlPath: string, onRestore: (entry: HistoryEntry) => void) {
        super(app);
        this.vault = vault;
        this.pluginDir = pluginDir;
        this.xmlPath = xmlPath;
        this.onRestore = onRestore;
    }

    async onOpen() {
        this.titleEl.setText(t('AI_TAB_HISTORY'));
        const list = this.contentEl.createDiv('diagrams-ai-history-list');
        const entries = await loadHistory(this.vault, this.pluginDir, this.xmlPath);
        if (!entries.length) {
            list.createDiv({ text: t('AI_HISTORY_EMPTY'), cls: 'diagrams-ai-history-empty' });
            return;
        }
        for (let i = entries.length - 1; i >= 0; i--) {
            const entry = entries[i];
            const item = list.createDiv('diagrams-ai-history-item');
            item.createDiv({ text: new Date(entry.ts).toLocaleString(), cls: 'diagrams-ai-history-time' });
            const summary = entry.prompt.length > 60 ? entry.prompt.slice(0, 60) + '…' : entry.prompt;
            item.createDiv({ text: summary, cls: 'diagrams-ai-history-prompt', attr: { 'aria-label': entry.prompt } });
            const restoreBtn = item.createEl('button', {
                text: t('AI_HISTORY_RESTORE'),
                cls: 'diagrams-ai-history-restore mod-cta',
            });
            restoreBtn.onclick = () => {
                this.onRestore(entry);
                this.close();
            };
        }
    }

    onClose() {
        this.contentEl.empty();
    }
}

/** 模板命名弹窗（P10）：确认后回调名称，取消/Esc 关闭回调 null */
class TemplateNameModal extends Modal {
    private onSubmit: (name: string | null) => void;
    private resolved = false;

    constructor(app: App, onSubmit: (name: string | null) => void) {
        super(app);
        this.onSubmit = onSubmit;
    }

    onOpen() {
        const { contentEl } = this;
        contentEl.addClass('diagrams-tpl-modal');
        const inputEl = contentEl.createEl('input', {
            type: 'text',
            attr: { placeholder: t('AI_TPL_NAME_PROMPT'), maxlength: '40' }
        });
        inputEl.addClass('diagrams-tpl-input');
        inputEl.focus();
        const submit = () => {
            this.resolved = true;
            this.onSubmit(inputEl.value);
            this.close();
        };
        const submitButton = contentEl.createEl('button', { text: t('AI_TPL_SAVE') });
        submitButton.addClass('mod-cta');
        submitButton.onclick = submit;
        const cancelButton = contentEl.createEl('button', { text: t('CANCEL') });
        cancelButton.onclick = () => {
            this.resolved = true;
            this.onSubmit(null);
            this.close();
        };
        inputEl.addEventListener('keypress', (event) => {
            if (event.key === 'Enter') submit();
        });
    }

    onClose() {
        // Esc / 点击遮罩退出时视为取消
        if (!this.resolved) this.onSubmit(null);
        this.contentEl.empty();
    }
}

/** 插入流：全屏 Modal 宿主（编辑已有图表 / 从命令与右键菜单创建并插入笔记） */
export default class DiagramsView extends Modal {
    private host: DiagramsEditorHost;

    constructor(
        app: App,
        hostView: View | null,
        fileInfo: { basename: string, svgPath: string, xmlPath: string, diagramExists: boolean },
        ui: string,
        settings: DiagramsSettings,
        pluginDir: string,
        onSaveSettings?: () => Promise<void>,
        initialPrompt?: string
    ) {
        super(app);
        this.host = new DiagramsEditorHost(app, {
            fileInfo,
            ui,
            settings,
            pluginDir,
            mode: 'modal',
            hostView,
            onSaveSettings,
            initialPrompt,
            onExit: () => this.close(),
        });
    }

    async onOpen() {
        // Modal 外壳：全屏铺满、隐藏默认关闭按钮（关闭入口为编辑器自带退出按钮 + Esc）
        this.modalEl.addClass('diagrams-modal-root', 'diagrams-modal-container');
        await this.host.open(this.contentEl);
    }

    async onClose() {
        this.host.destroy();
    }
}
