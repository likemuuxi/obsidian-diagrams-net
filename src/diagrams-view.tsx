import { App, MarkdownView, Modal, TFile, Vault, View, Workspace, Notice } from 'obsidian';
import * as React from "react";
import * as ReactDOM from "react-dom";
import { DIAGRAM_VIEW_TYPE } from './constants';
import { DiagramsApp } from './DiagramsApp';

export default class DiagramsView extends Modal {
    filePath: string;
    fileName: string;
    svgPath: string;
    xmlPath: string;
    diagramExists: boolean;
    hostView: View;
    vault: Vault;
    workspace: Workspace;
    displayText: string;
    ui: string;

    getDisplayText(): string {
        return this.displayText ?? 'Diagram';
    }

    getViewType(): string {
        return DIAGRAM_VIEW_TYPE;
    }

    constructor(app: App, hostView: View,
        initialFileInfo: { path: string, basename: string, svgPath: string, xmlPath: string, diagramExists: boolean },
        ui: string) {
        super(app);
        this.filePath = initialFileInfo.path;
        this.fileName = initialFileInfo.basename;
        this.svgPath = initialFileInfo.svgPath;
        this.xmlPath = initialFileInfo.xmlPath;
        this.diagramExists = initialFileInfo.diagramExists;
        this.vault = this.app.vault;
        this.workspace = this.app.workspace;
        this.hostView = hostView
        this.ui = ui
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

        const handleExit = async () => {
            close()
        }

        const handleSaveAndExit = async (msg: any) => {
            if (this.diagramExists) {
                saveData(msg)
                await refreshMarkdownViews()
            } else {
                saveData(msg)
                insertDiagram()
            }
            close()
        }

        const close = () => {
            this.workspace.detachLeavesOfType(DIAGRAM_VIEW_TYPE);
            this.close();
        }

        const saveData = (msg: any) => {
            const svgData = msg.svgMsg.data
            const svgBuffer = Buffer.from(svgData.replace('data:image/svg+xml;base64,', ''), 'base64')
            if (this.diagramExists) {
                const svgFile = this.vault.getAbstractFileByPath(this.svgPath)
                const xmlFile = this.vault.getAbstractFileByPath(this.xmlPath)
                if (!(svgFile instanceof TFile && xmlFile instanceof TFile)) {
                    return
                }
                this.vault.modifyBinary(svgFile, svgBuffer)
                this.vault.modify(xmlFile, msg.svgMsg.xml)
            }
            else {
                this.vault.createBinary(this.svgPath, svgBuffer)
                this.vault.create(this.xmlPath, msg.svgMsg.xml)
            }
        }

        const refreshMarkdownViews = async () => {
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
                const editor = this.app.workspace.getActiveViewOfType(MarkdownView).editor;
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

            // 处理后滚动条回去
            setTimeout(() => {
                const editView = view.currentMode;
                editView.applyScroll(scrollPosition);
            }, 500);
        }

        const insertDiagram = () => {
            // @ts-ignore: Type not documented.
            const cursor = this.hostView.editor.getCursor();
            // @ts-ignore: Type not documented.
            this.hostView.editor.replaceRange(`![[${this.svgPath}]]`, cursor);
        }

        const container = this.containerEl.children[1];
        container.setAttr("style", "width: 100vw; height: 100vh;");


        ReactDOM.render(
            <DiagramsApp
                xmlPath={this.xmlPath}
                diagramExists={this.diagramExists}
                vault={this.vault}
                handleExit={handleExit}
                handleSaveAndExit={handleSaveAndExit}
                ui={this.ui}
            />,
            container
        );
    }

    async onClose() {
        ReactDOM.unmountComponentAtNode(this.containerEl.children[1]);
    }

}