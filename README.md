# Obsidian Diagrams.Net


A plugin for [Obsidian](https://obsidian.md/) for inserting and editing [diagrams.net](https://diagrams.net/) (previously draw.io) diagrams. It differs from the [drawio-obsidian](https://github.com/zapthedingbat/drawio-obsidian) plugin in that it embeds the diagrams.net online editor, which requires an active internet connection, but enables the full feature set and all the shape libraries.

![1726331570398-20240915_003106](https://github.com/user-attachments/assets/708d7df8-17a0-4333-be04-fb121f9f852f)

![1726331811989-20240915_003406](https://github.com/user-attachments/assets/43a1c3d2-1810-4b23-be58-af5e100088c0)

> ## ⚠️ **Caveats**
> As Obsidian itself has an API that is under development, so is this plugin. There are some things you should be aware of if you are using it:
> 
> - Diagrams are saved as a separate file – ``MyDiagram.svg.xml``, alongside their image representation – ``MyDiagram.svg``. (The .xml-file can be opened directly in any diagrams.net-editor.)
> - Moving and renaming a diagram inside Obsidian will do so for both the diagram file and the image file. However, since there is no "copy" event to listen to in the Obsidian API, copying a diagram means the new diagram will not have a diagram file associated with it, and as such, cannot be opened in the editor.
> - The workaround, if you need to copy a diagram, is to manually duplicate and rename both the image and diagram file.

