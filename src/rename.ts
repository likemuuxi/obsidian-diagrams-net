import { Modal, App } from "obsidian";
import { t } from "./lang/helpers";

export class RenameModal extends Modal {
    private onSubmit: (newName: string) => void;
    private defaultName: string;

    constructor(app: App, defaultName: string, onSubmit: (newName: string) => void) {
        super(app);
        this.defaultName = defaultName;
        this.onSubmit = onSubmit;
    }

    onOpen() {
        const { contentEl } = this;
		contentEl.addClass("rename-diagrams-modal");

        // 创建输入框
        const inputEl = contentEl.createEl("input", { type: "text", value: this.defaultName });
        inputEl.classList.add("rename-input");

        // 创建重命名按钮
        const submitButton = contentEl.createEl("button", { text: t("RENAME") });
        submitButton.classList.add("rename-button");
        submitButton.onclick = () => {
            this.onSubmit(inputEl.value);
            this.close();
        };

        // 创建取消按钮
        const cancelButton = contentEl.createEl("button", { text: t("CANCEL") });
        cancelButton.classList.add("cancel-button");
        cancelButton.onclick = () => {
            this.close();
        };

        // 允许按 Enter 键提交
        inputEl.addEventListener("keypress", (event) => {
            if (event.key === "Enter") {
                this.onSubmit(inputEl.value);
                this.close();
            }
        });
    }

    onClose() {
        this.contentEl.empty();
    }
}
