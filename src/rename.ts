import { Modal, App } from "obsidian";
import { t } from "./lang/helpers";

export class RenameModal extends Modal {
    private onSubmit: (newName: string | null) => void;
    private defaultName: string;
    private resolved = false;

    constructor(app: App, defaultName: string, onSubmit: (newName: string | null) => void) {
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

        const submit = () => {
            this.resolved = true;
            this.onSubmit(inputEl.value);
            this.close();
        };

        // 创建重命名按钮
        const submitButton = contentEl.createEl("button", { text: t("RENAME") });
        submitButton.classList.add("rename-button");
        submitButton.onclick = submit;

        // 创建取消按钮
        const cancelButton = contentEl.createEl("button", { text: t("CANCEL") });
        cancelButton.classList.add("cancel-button");
        cancelButton.onclick = () => {
            this.resolved = true;
            this.onSubmit(null);
            this.close();
        };

        // 允许按 Enter 键提交
        inputEl.addEventListener("keypress", (event) => {
            if (event.key === "Enter") {
                submit();
            }
        });
    }

    onClose() {
        // 通过 Esc 或关闭按钮退出时视为取消
        if (!this.resolved) {
            this.onSubmit(null);
        }
        this.contentEl.empty();
    }
}
