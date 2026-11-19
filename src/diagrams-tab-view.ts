import { ItemView, ViewStateResult, WorkspaceLeaf } from 'obsidian';
import type DiagramsNet from './main';
import { DiagramsEditorHost } from './diagrams-view';
import { t } from './lang/helpers';

export const VIEW_TYPE_DIAGRAMS = 'diagrams-net-editor';

export interface DiagramsTabState {
    fileBasename: string;
    svgPath: string;
    xmlPath: string;
    diagramExists: boolean;
}

/**
 * 创建流：工作区标签页宿主。
 * 由侧边栏"创建新图表"按钮打开；保存并退出仅落盘（svg + xml）后关闭标签页，
 * 不向当前笔记插入链接；不保存退出直接关闭标签页。
 *
 * state 注入不依赖 onOpen/setState 的调用顺序：
 * - 直接打开：构造函数注入（main.ts 用 leaf.open(view) 传入实例）
 * - 布局恢复：registerView 工厂创建后由 setState 注入（onOpen 前后皆可补初始化）
 */
export class DiagramsTabView extends ItemView {
    private plugin: DiagramsNet;
    private host: DiagramsEditorHost | null = null;
    private state: DiagramsTabState | null;
    private opened = false;

    constructor(leaf: WorkspaceLeaf, plugin: DiagramsNet, state?: DiagramsTabState) {
        super(leaf);
        this.plugin = plugin;
        this.state = state && state.svgPath && state.xmlPath ? state : null;
    }

    getViewType() {
        return VIEW_TYPE_DIAGRAMS;
    }

    getIcon() {
        return 'diagram';
    }

    getDisplayText() {
        return this.state?.svgPath.split('/').pop() || t('CREATE_NEW_DIAGRAM');
    }

    getState(): Record<string, unknown> {
        return this.state ? { ...this.state } : {};
    }

    async setState(state: DiagramsTabState, result: ViewStateResult) {
        this.state = state && state.svgPath && state.xmlPath ? state : null;
        await super.setState(state, result);
        // 布局恢复时 setState 可能晚于 onOpen：此时补建编辑器
        if (this.state && !this.host && this.opened) {
            await this.initHost();
        }
    }

    async onOpen() {
        this.opened = true;
        if (this.state) {
            await this.initHost();
        }
    }

    /** 构建/重建编辑器（幂等：先销毁旧实例并清空容器） */
    private async initHost() {
        const state = this.state;
        if (!state) return;
        this.host?.destroy();
        this.host = null;
        this.contentEl.empty();
        this.host = new DiagramsEditorHost(this.app, {
            fileInfo: {
                basename: state.fileBasename,
                svgPath: state.svgPath,
                xmlPath: state.xmlPath,
                diagramExists: state.diagramExists,
            },
            ui: this.plugin.ui,
            settings: this.plugin.settings,
            pluginDir: this.plugin.manifest.dir,
            mode: 'tab',
            onSaveSettings: () => this.plugin.saveSettings(),
            // 创建保存时重命名成功：同步标签页标题
            onRenamed: (basename) => {
                this.state = this.state && {
                    ...this.state,
                    fileBasename: basename,
                    svgPath: this.state.svgPath.replace(/[^/]+\.svg$/, `${basename}.svg`),
                };
                // @ts-ignore: 运行时存在但未收录进官方类型声明
                this.leaf.tabHeaderInnerTitleEl?.setText(this.getDisplayText());
            },
            // 编辑器内点击"退出"：卸载标签页
            onExit: () => this.leaf.detach(),
        });
        await this.host.open(this.contentEl);
    }

    async onClose() {
        this.host?.destroy();
        this.host = null;
        this.opened = false;
    }
}
