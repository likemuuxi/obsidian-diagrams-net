import { App, MarkdownView, Modal, TFile, Vault, View, Workspace, Notice, Platform } from 'obsidian';
import * as React from "react";
import * as ReactDOM from "react-dom";
import { DIAGRAM_VIEW_TYPE } from './constants';
import { DiagramsApp } from './DiagramsApp';
import { RenameModal } from './rename';
import { DiagramsSettings } from "./settings";

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
    settings: DiagramsSettings;

    getDisplayText(): string {
        return this.displayText ?? 'Diagram';
    }

    getViewType(): string {
        return DIAGRAM_VIEW_TYPE;
    }

    constructor(app: App, hostView: View,
        initialFileInfo: { path: string, basename: string, svgPath: string, xmlPath: string, diagramExists: boolean },
        ui: string, settings: DiagramsSettings) {
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

        const handleExit = async () => {
            close()
        }

        const handleSaveAndExit = async (msg: any) => {
            if (this.diagramExists) {
                saveData(msg);
                await refreshMarkdownViews();
            } else {
                saveData(msg);
                if(!this.settings.createAndRename) {
                    insertDiagram();
                }
            }
            close();
        };

        
        const close = () => {
            this.workspace.detachLeavesOfType(DIAGRAM_VIEW_TYPE);
            this.close();
        }

        const saveData = async (msg: any, onCreate?: (svgPath: string, xmlPath: string) => Promise<void>) => {
            const svgData = msg.svgMsg.data;
            const svgBuffer = Buffer.from(svgData.replace('data:image/svg+xml;base64,', ''), 'base64');
            
            if (this.diagramExists) {
                // 图表已存在，修改文件
                const svgFile = this.vault.getAbstractFileByPath(this.svgPath);
                const xmlFile = this.vault.getAbstractFileByPath(this.xmlPath);
                if (!(svgFile instanceof TFile && xmlFile instanceof TFile)) {
                    return;
                }
                await this.vault.modifyBinary(svgFile, svgBuffer);
                await this.vault.modify(xmlFile, msg.svgMsg.xml);
            } else {
                // 图表不存在，创建新文件
                const svgFile = await this.vault.createBinary(this.svgPath, svgBuffer);
                const xmlFile = await this.vault.create(this.xmlPath, msg.svgMsg.xml);

                // 确保文件成功创建后立刻执行重命名
                if (svgFile instanceof TFile && xmlFile instanceof TFile && this.settings.createAndRename) {
                    await renameFiles(svgFile.path, xmlFile.path); 
                }
            }
        };

        // const saveData = async (msg: any) => {
        //     try {
        //         const base64Data = msg.svgMsg.data.replace('data:image/svg+xml;base64,', '');
                
        //         // 将base64数据转换为二进制格式（现代浏览器推荐方式）
        //         const response = await fetch(`data:application/octet-stream;base64,${base64Data}`);
        //         const uint8Array = new Uint8Array(await response.arrayBuffer());
        
        //         if (this.diagramExists) {
        //             // 已存在图表时的更新逻辑
        //             const svgFile = this.vault.getAbstractFileByPath(this.svgPath);
        //             const xmlFile = this.vault.getAbstractFileByPath(this.xmlPath);
        //             if (!(svgFile instanceof TFile && xmlFile instanceof TFile)) return;
                    
        //             await this.vault.modifyBinary(svgFile, uint8Array);
        //             await this.vault.modify(xmlFile, msg.svgMsg.xml);
        //         } else {
        //             // 新图表创建逻辑
        //             const svgFile = await this.vault.createBinary(this.svgPath, uint8Array);
        //             const xmlFile = await this.vault.create(this.xmlPath, msg.svgMsg.xml);
        //             if (
        //                 svgFile instanceof TFile &&
        //                 xmlFile instanceof TFile &&
        //                 this.settings.createAndRename
        //             ) {
        //                 // 调用重命名函数并传入文件路径
        //                 await renameFiles(svgFile.path, xmlFile.path);
        //             }
        //         }
        //     } catch (error) {
        //         // 错误处理（建议优化为模板字符串）
        //         new Notice(`Save failed: ${error}`);
        //     }
        // };
        
        const renameFiles = async (svgPath: string, xmlPath: string) => {
            const newName = await promptForNewName(this.fileName);  // 弹出模态框获取新名称
            if (!newName) return;  // 如果没有输入新名称，直接返回
            const basePath = this.vault.getAbstractFileByPath(svgPath)?.parent.path;

            let newSvgPath, newXmlPath;
            if(basePath == '/') {
                newSvgPath = `${newName}.svg`;
                newXmlPath = `${newName}.xml`;
            } else {
                newSvgPath = `${basePath}/${newName}.svg`;
                newXmlPath = `${basePath}/${newName}.xml`;
            }
            
            const svgFile = this.vault.getAbstractFileByPath(svgPath);
            const xmlFile = this.vault.getAbstractFileByPath(xmlPath);

            if (svgFile && xmlFile) {
                await this.vault.rename(svgFile, newSvgPath);
                this.svgPath = newSvgPath;
                this.xmlPath = newXmlPath;
                this.fileName = newName;

                insertDiagram();
            }
        };

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

            // 处理后滚动回去
            setTimeout(() => {
                const editView = view.currentMode;
                editView.applyScroll(scrollPosition);
            }, 500);
        }

        const promptForNewName = (defaultName: string): Promise<string | null> => {
            return new Promise((resolve) => {
                const modal = new RenameModal(this.app, defaultName, (newName) => {
                    resolve(newName);
                });
                modal.open();
            });
        };        

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