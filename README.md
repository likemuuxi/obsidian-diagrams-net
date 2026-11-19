# Obsidian Diagrams.Net


A plugin for [Obsidian](https://obsidian.md/) for inserting and editing [diagrams.net](https://diagrams.net/) (previously draw.io) diagrams. It differs from the [drawio-obsidian](https://github.com/zapthedingbat/drawio-obsidian) plugin in that it embeds the diagrams.net online editor, which requires an active internet connection, but enables the full feature set and all the shape libraries.

![1726331570398-20240915_003106](https://github.com/user-attachments/assets/eb15b6b2-697e-45c4-b21c-b34fa131cb22)

![1726331811989-20240915_003406](https://github.com/user-attachments/assets/71aced54-474f-430f-afb3-cda153b144e1)

## AI Assistant

The editor opens with an AI panel on the right side. Describe a diagram in natural language and it is generated directly onto the canvas; if the canvas already has content, instructions are applied to the current diagram (e.g. "add a reject branch to the review node").

- **Works with any OpenAI-compatible API** — configure endpoint / model / API key in the plugin settings (OpenAI, DeepSeek, Kimi, OpenRouter, local Ollama, …).
- **Multi-turn refinement** — conversation history is sent back to the model, so iterative instructions like "make it simpler" or "same style" work.
- **Undo & regenerate** — every AI application can be reverted with one click (the canvas undo stack is reset by reloads, so the plugin keeps its own snapshots), and a "Regenerate" button retries from the pre-generation state.
- **Template chips** — one-click starters for flowchart, swimlane, sequence, ER, UML class and mind map diagrams.
- **XML view** — inspect or hand-edit the diagram XML and apply it with the same auto-repair pipeline used for AI output.
- **Safety guards** — overly large diagrams are rejected before being sent to the model; multi-page diagram files keep their other pages when the AI edits page 1.

> ## ⚠️ **Caveats**
> As Obsidian itself has an API that is under development, so is this plugin. There are some things you should be aware of if you are using it:
> 
> - Diagrams are saved as a separate file – ``MyDiagram.svg.xml``, alongside their image representation – ``MyDiagram.svg``. (The .xml-file can be opened directly in any diagrams.net-editor.)
> - Moving and renaming a diagram inside Obsidian will do so for both the diagram file and the image file. However, since there is no "copy" event to listen to in the Obsidian API, copying a diagram means the new diagram will not have a diagram file associated with it, and as such, cannot be opened in the editor.
> - The workaround, if you need to copy a diagram, is to manually duplicate and rename both the image and diagram file.

