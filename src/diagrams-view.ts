import { App, MarkdownView, Modal, TFile, Vault, View, Notice } from 'obsidian';
import { t } from './lang/helpers';
import { DiagramsEditor } from './diagramsEditor';
import { RenameModal } from './rename';
import { DiagramsSettings } from "./settings";

export default class DiagramsView extends Modal {
    fileName: string;
    svgPath: string;
    xmlPath: string;
    diagramExists: boolean;
    hostView: View;
    vault: Vault;
    ui: string;
    settings: DiagramsSettings;
    private editor: DiagramsEditor | null = null;
    private xmlData: string | null = null;

    constructor(app: App, hostView: View,
        initialFileInfo: { basename: string, svgPath: string, xmlPath: string, diagramExists: boolean },
        ui: string, settings: DiagramsSettings) {
        super(app);
        this.fileName = initialFileInfo.basename;
        this.svgPath = initialFileInfo.svgPath;
        this.xmlPath = initialFileInfo.xmlPath;
        this.diagramExists = initialFileInfo.diagramExists;
        this.vault = this.app.vault;
        this.hostView = hostView
        this.ui = ui
        this.settings = settings;
    }


    async onOpen() {
        const modalBgElement = document.querySelector(".modal-bg") as HTMLElement;
        if (modalBgElement) {
            modalBgElement.addEventListener("click", async (event) => {
                if (event.target === modalBgElement) {
                    event.stopImmediatePropagation();
                    event.preventDefault();
                }
            }, true);
        }

        const container = this.containerEl.children[1] as HTMLElement;
        container.setAttr("style", "width: 100vw; height: 100vh;");

        // 读取已有图表数据（新建时跳过）
        if (this.diagramExists) {
            const xmlFile = this.vault.getAbstractFileByPath(this.xmlPath);
            if (!(xmlFile instanceof TFile)) {
                new Notice(t('DIAGRAM_DATA_MISSING'));
                this.close();
                return;
            }
            this.xmlData = await this.vault.cachedRead(xmlFile);
        }

        this.editor = new DiagramsEditor(container, this.ui, this.settings.embedUrl, {
            onSave: (msg) => this.handleSaveAndExit(msg),
            onExit: () => this.close(),
            getData: () => this.xmlData,
        });
        this.editor.start();
    }

    async onClose() {
        this.editor?.stop();
        this.editor = null;
    }

    // 必须等写盘（以及可选的重命名）完成后才能关闭/刷新，否则存在竞态
    private async handleSaveAndExit(msg: any) {
        await this.saveData(msg);
        if (this.diagramExists) {
            await this.refreshMarkdownViews();
        } else if (!this.settings.createAndRename) {
            this.insertDiagram();
        }
        this.close();
    };

    private async saveData(msg: any) {
        const svgBuffer = Buffer.from(msg.data.replace('data:image/svg+xml;base64,', ''), 'base64');
        const svgArrayBuffer = new Uint8Array(svgBuffer).buffer;

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

            // 确保文件成功创建后立刻执行重命名
            if (svgFile instanceof TFile && xmlFile instanceof TFile && this.settings.createAndRename) {
                await this.renameFiles(svgFile.path, xmlFile.path);
            }
        }
    };

    private async renameFiles(svgPath: string, xmlPath: string) {
        const newName = await this.promptForNewName(this.fileName);
        // 取消重命名时，按原文件名插入图表
        if (!newName || !newName.trim()) {
            this.insertDiagram();
            return;
        }
        const parentPath = this.vault.getAbstractFileByPath(svgPath)?.parent?.path ?? '/';
        const newSvgPath = parentPath === '/' ? `${newName}.svg` : `${parentPath}/${newName}.svg`;
        const newXmlPath = newSvgPath.slice(0, -4) + '.xml';

        const svgFile = this.vault.getAbstractFileByPath(svgPath);
        const xmlFile = this.vault.getAbstractFileByPath(xmlPath);
        if (!(svgFile instanceof TFile && xmlFile instanceof TFile)) {
            this.insertDiagram();
            return;
        }

        try {
            // 先重命名 xml 再重命名 svg，避免 svg 的 rename 事件联动重命名造成冲突
            await this.vault.rename(xmlFile, newXmlPath);
            this.xmlPath = newXmlPath;
            await this.vault.rename(svgFile, newSvgPath);
            this.svgPath = newSvgPath;
            this.fileName = newName;
        } catch (error) {
            new Notice(`${t('RENAME_FAILED')}: ${error}`);
        }
        this.insertDiagram();
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
