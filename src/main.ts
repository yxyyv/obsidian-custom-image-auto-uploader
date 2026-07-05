import { CachedMetadata, MarkdownView, Menu, Notice, Plugin, TFile, debounce } from "obsidian";

import {
  autoAddExcludeDomain,
  generateRandomString,
  getAttachmentUploadPath,
  hasExcludeDomain,
  imageDown,
  imageUpload,
  metadataCacheHandle,
  parseWikiImageLink,
  replaceInTextForDownload,
  replaceInTextForUpload,
  setMenu,
  showErrorNotice,
  showTaskNotice,
  statusCheck,
} from "./lib/utils";
import { DeletedNoteRemoteImageRecord, DownTask, RemoteTrashTask, RemoteTrashTaskSource, RemoteTrashTaskStore, UploadTask } from "./lib/interface";
import { DEFAULT_SETTINGS, PluginSettings, SettingTab } from "./setting";
import { $ } from "./lang/lang";

const wikilinkImageRegex = /!\[\[([^\]]+)\]\]/g;
const markdownImageRegex = /!\[([^\]]*)\]\((.*?)\s*("(?:.*[^"])")?\s*\)/g;

interface PersistedPluginData {
  settings: PluginSettings
  remoteTrash: RemoteTrashTaskStore
  deletedNotes?: DeletedNoteRemoteImageRecord[]
}

interface RemoveRemoteImageReferenceResult {
  removed: boolean
  normalizedContent: string
}

interface RemoteImageReferenceSearchOptions {
  contentOverrides?: Record<string, string>
  excludeFilePaths?: string[]
}

interface RemoteImageReferenceLocation {
  filePath: string
  kind: "markdown" | "metadata"
}

interface RemoteFileImageExtractOptions {
  filePath: string
  content?: string
  cache?: CachedMetadata
}

const DEFAULT_REMOTE_TRASH_STORE: RemoteTrashTaskStore = {
  pendingTasks: [],
  historyTasks: [],
};

function sleep(ms: number) {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

export default class CustomImageAutoUploader extends Plugin {
  settingTab: SettingTab
  settings: PluginSettings
  statusBar: HTMLElement[] = []
  downloadStatus: { current: number; total: number } = { current: 0, total: 0 }
  uploadStatus: { current: number; total: number } = { current: 0, total: 0 }
  statusType: "download" | "upload" | "all" | "none" = "none"
  fromPluginSet = false
  remoteTrashTasks: RemoteTrashTaskStore = structuredClone(DEFAULT_REMOTE_TRASH_STORE)
  deletedNoteRecords: DeletedNoteRemoteImageRecord[] = []
  noteContentSnapshots: Record<string, string> = {}
  remoteTrashTimer: number | null = null
  isProcessingRemoteTrashTasks = false

  resetStatus(type: "download" | "upload" | "all" | "none", reset: boolean = true): void {
    this.statusType = type

    if (reset) {
      this.downloadStatus = { current: 0, total: 0 }
      this.uploadStatus = { current: 0, total: 0 }
    }

    statusCheck(this)
  }

  async onload() {
    await this.loadPluginState()

    statusCheck(this)

    this.settingTab = new SettingTab(this.app, this)
    this.addSettingTab(this.settingTab)

    this.pruneRemoteTrashHistory()
    await this.processPendingRemoteTrashTasks()
    this.startRemoteTrashTaskPolling()

    const debouncedProcess = debounce(
      async () => {
        if (!this.fromPluginSet) {
          this.resetStatus("all", true)
          await this.ContentImageAutoHandle()
          await this.MetadataImageAutoHandle()
          showTaskNotice(this, "all")
        }
        await this.reconcilePendingRemoteTrashTasks()
      },
      1000,
      true
    )

    this.registerEvent(this.app.workspace.on("editor-change", debouncedProcess))
    this.registerEvent(this.app.vault.on("modify", (file) => {
      void this.captureNoteSnapshot(file)
    }))
    this.registerEvent(this.app.vault.on("create", (file) => {
      void this.handleVaultCreate(file)
    }))
    this.registerEvent(this.app.vault.on("delete", (file) => {
      void this.handleVaultDelete(file)
    }))
    this.registerEvent(this.app.vault.on("rename", (file, oldPath) => {
      void this.handleVaultRename(file, oldPath)
    }))

    this.addCommand({
      id: "down-current-images",
      name: $("下载当前笔记图片"),
      callback: async () => {
        this.resetStatus("download", true)
        await this.ContentDownImage()
        await this.MetadataDownImage()
        showTaskNotice(this, "download")
      },
    })
    this.addCommand({
      id: "upload-current-images",
      name: $("上传当前笔记图片"),
      callback: async () => {
        this.resetStatus("upload", true)
        await this.ContentUploadImage()
        await this.MetadataUploadImage()
        showTaskNotice(this, "upload")
      },
    })
    this.addCommand({
      id: "down-vault-images",
      name: $("下载全库图片"),
      callback: async () => {
        this.resetStatus("download", true)
        await this.VaultDownImage()
        showTaskNotice(this, "download")
      },
    })
    this.addCommand({
      id: "upload-vault-images",
      name: $("上传全库图片"),
      callback: async () => {
        this.resetStatus("upload", true)
        await this.VaultUploadImage()
        showTaskNotice(this, "upload")
      },
    })
    this.addCommand({
      id: "delete-unreferenced-images",
      name: $("删除未引用图片（全库）"),
      callback: async () => {
        await this.VaultDeleteUnreferencedImages()
      },
    })

    this.registerEvent(
      this.app.workspace.on("file-menu", (menu: Menu) => {
        setMenu(menu, this, true, true)
      })
    )
    this.registerEvent(
      this.app.workspace.on("editor-menu", (menu: Menu) => {
        setMenu(menu, this, true, true)
      })
    )
    this.registerEvent(
      this.app.workspace.on("url-menu", (menu: Menu, url: string) => {
        this.addDeleteCurrentImageMenuItem(menu, url)
      })
    )
    this.addRibbonIcon("image", "Custom Image Auto Uploader", (event) => {
      const menu = new Menu()
      setMenu(menu, this, true)
      menu.showAtMouseEvent(event)
    })
  }

  onunload() {
    if (this.remoteTrashTimer !== null) {
      window.clearInterval(this.remoteTrashTimer)
      this.remoteTrashTimer = null
    }
  }

  async ContentImageAutoHandle(isManual: boolean = false) {
    if (this.settings.isAutoDown || isManual) {
      await this.ContentDownImage()
    }
    if (this.settings.isAutoUpload || isManual) {
      await sleep(this.settings.afterUploadTimeout)
      await this.ContentUploadImage()
    }
  }

  async MetadataImageAutoHandle(isManual: boolean = false) {
    if (this.settings.isAutoDown || isManual) {
      await this.MetadataDownImage()
    }
    if (this.settings.isAutoUpload || isManual) {
      await sleep(this.settings.afterUploadTimeout)
      await this.MetadataUploadImage()
    }
  }

  async ContentDownImage() {
    if (!this.app.workspace.activeEditor || !this.app.workspace.activeEditor.editor) return

    const cursor = this.app.workspace.activeEditor.editor.getCursor()
    const fileFullContent = this.app.workspace.activeEditor.editor.getValue() || ""
    if (!fileFullContent) return

    let filePropertyContent = ""
    let filePropertyContentEndLine = 0
    let fileContent = ""
    const propertyMatch = fileFullContent.match(/^---\s*\r?\n([\s\S]*?)\r?\n---\s*\r?\n?/g)

    if (propertyMatch) {
      fileContent = fileFullContent.substring(propertyMatch[0].length)
      filePropertyContent = propertyMatch[0]

      const activeFile = this.app.workspace.getActiveFile()
      if (activeFile) {
        const cachedMetadata = this.app.metadataCache.getFileCache(activeFile)
        filePropertyContentEndLine = cachedMetadata?.frontmatterPosition?.end.line || 0
      }
    } else {
      fileContent = fileFullContent
    }

    const downloadTasks: DownTask[] = []
    const matches = fileContent.matchAll(markdownImageRegex)
    const uniqueTask = new Set<string>()
    for (const match of matches) {
      if (uniqueTask.has(match[0])) continue
      uniqueTask.add(match[0])

      if (!/^http/.test(match[2]) || hasExcludeDomain(match[2], this.settings.excludeDomains)) {
        continue
      }

      let imageAlt = match[3] ? match[3] : match[1] ? match[1] : ""
      imageAlt = imageAlt.replaceAll("\"", "")
      downloadTasks.push({
        matchText: match[0],
        imageAlt,
        imageUrl: match[2],
      })

      this.downloadStatus.total++
      statusCheck(this)
    }

    let isModify = false
    const downloadResults = await Promise.all(
      downloadTasks.map(async (task) => {
        const result = await imageDown(task.imageUrl, this)
        return { task, result }
      })
    )

    for (const { task, result } of downloadResults) {
      if (result.err) {
        showErrorNotice(result.msg)
      } else if (result.path) {
        isModify = true
        this.downloadStatus.current++
        statusCheck(this)
        fileContent = replaceInTextForDownload(fileContent, task.matchText, task.imageAlt, result.path)
      }
    }

    if (isModify) {
      this.fromPluginSet = true
      this.app.workspace.activeEditor?.editor?.setValue(filePropertyContent + fileContent)
      await this.app.workspace.activeEditor?.editor?.setCursor({ line: cursor.line - filePropertyContentEndLine, ch: 0 })
      this.fromPluginSet = false
    }
  }

  async ContentUploadImage() {
    if (!this.app.workspace.activeEditor || !this.app.workspace.activeEditor.editor) return

    const cursor = this.app.workspace.activeEditor.editor.getCursor()
    const fileFullContent = this.app.workspace.activeEditor.editor.getValue() || ""
    if (!fileFullContent) return

    let filePropertyContent = ""
    let fileContent = ""
    const propertyMatch = fileFullContent.match(/^---\s*\r?\n([\s\S]*?)\r?\n---\s*\r?\n?/g)

    if (propertyMatch) {
      fileContent = fileFullContent.substring(propertyMatch[0].length)
      filePropertyContent = propertyMatch[0]
    } else {
      fileContent = fileFullContent
    }

    const uploadTasks: UploadTask[] = []
    const matches = fileContent.matchAll(wikilinkImageRegex)
    const uniqueTask = new Set<string>()
    for (const match of matches) {
      if (uniqueTask.has(match[0])) continue
      uniqueTask.add(match[0])

      const parsedLink = parseWikiImageLink(match[1])
      if (/^http/.test(parsedLink.file)) {
        continue
      }

      const file = parsedLink.file
      const readfile = await getAttachmentUploadPath(file, this)
      if (!readfile) continue

      uploadTasks.push({
        matchText: match[0],
        imageAlt: parsedLink.imageAlt,
        imageDisplayText: parsedLink.imageDisplayText,
        imageSize: parsedLink.imageSize,
        imageFile: readfile,
      })
      this.uploadStatus.total++
      statusCheck(this)
    }

    let isModify = false
    const uploadResults = await Promise.all(
      uploadTasks.map(async (task) => {
        const result = await imageUpload(task.imageFile, this.settings.contentSet, this)
        return { task, result }
      })
    )

    for (const { task, result } of uploadResults) {
      if (result.err) {
        showErrorNotice(result.msg)
      } else if (result.imageUrl) {
        isModify = true
        this.uploadStatus.current++
        statusCheck(this)

        const searchStr = this.settings.uploadImageRandomSearch ? `?${generateRandomString(10)}` : ""
        fileContent = replaceInTextForUpload(fileContent, task.matchText, task.imageAlt, result.imageUrl + searchStr, task.imageDisplayText)
        autoAddExcludeDomain(result.imageUrl, this)
      }
    }

    if (isModify) {
      this.fromPluginSet = true
      this.app.workspace.activeEditor?.editor?.setValue(filePropertyContent + fileContent)
      await this.app.workspace.activeEditor?.editor?.setCursor(cursor)
      this.fromPluginSet = false
    }
  }

  async MetadataDownImage() {
    if (this.settings.propertyNeedSets.length === 0) {
      return
    }
    const activeFile = this.app.workspace.getActiveFile()
    if (!activeFile) return

    const cachedMetadata = this.app.metadataCache.getFileCache(activeFile)
    if (!cachedMetadata) return

    const downloadTasks: DownTask[] = []
    const metadata = metadataCacheHandle(cachedMetadata, this)
    for (const item of metadata) {
      for (const pic of item.value) {
        if (!/^http/.test(pic) || hasExcludeDomain(pic, this.settings.excludeDomains)) {
          continue
        }
        downloadTasks.push({
          matchText: pic,
          imageAlt: "",
          imageUrl: pic,
          metadataItem: item,
        })
        this.downloadStatus.total++
        statusCheck(this)
      }
    }

    let isModify = false
    const downloadResults = await Promise.all(
      downloadTasks.map(async (task) => {
        const result = await imageDown(task.imageUrl, this)
        return { task, result }
      })
    )

    for (const { task, result } of downloadResults) {
      if (result.err) {
        showErrorNotice(result.msg)
      } else if (result.path && task.metadataItem) {
        isModify = true
        this.downloadStatus.current++
        statusCheck(this)
        const index = task.metadataItem.value.indexOf(task.matchText)
        if (index !== -1) {
          task.metadataItem.value[index] = result.path
        }
      }
    }

    if (isModify) {
      this.fromPluginSet = true
      await this.app.fileManager.processFrontMatter(activeFile, (frontmatter) => {
        for (const item of metadata) {
          frontmatter[item.key] = item.type === "string" ? item.value[0] : item.value
        }
      })
      window.setTimeout(() => {
        this.fromPluginSet = false
      }, 1000)
    }
  }

  async MetadataUploadImage() {
    if (this.settings.propertyNeedSets.length === 0) {
      return
    }
    const activeFile = this.app.workspace.getActiveFile()
    if (!activeFile) return

    const cachedMetadata = this.app.metadataCache.getFileCache(activeFile)
    if (!cachedMetadata) return

    const uploadTasks: UploadTask[] = []
    const metadata = metadataCacheHandle(cachedMetadata, this)
    for (const item of metadata) {
      for (const pic of item.value) {
        if (/^http/.test(pic)) {
          continue
        }
        const readfile = await getAttachmentUploadPath(pic, this)
        if (!readfile || !item.params) continue

        uploadTasks.push({
          matchText: pic,
          imageAlt: "",
          imageFile: readfile,
          metadataItem: item,
        })

        this.uploadStatus.total++
        statusCheck(this)
      }
    }

    let isModify = false
    const uploadResults = await Promise.all(
      uploadTasks.map(async (task) => {
        const result = await imageUpload(task.imageFile, task.metadataItem?.params, this)
        return { task, result }
      })
    )

    for (const { task, result } of uploadResults) {
      if (result.err) {
        showErrorNotice(result.msg)
      } else if (result.imageUrl && task.metadataItem) {
        isModify = true
        this.uploadStatus.current++
        statusCheck(this)
        const searchStr = this.settings.uploadImageRandomSearch ? `?${generateRandomString(10)}` : ""
        const index = task.metadataItem.value.indexOf(task.matchText)
        if (index !== -1) {
          task.metadataItem.value[index] = result.imageUrl + searchStr
        }
      }
    }

    if (isModify) {
      this.fromPluginSet = true
      await this.app.fileManager.processFrontMatter(activeFile, (frontmatter) => {
        for (const item of metadata) {
          frontmatter[item.key] = item.type === "string" ? item.value[0] : item.value
        }
      })
      window.setTimeout(() => {
        this.fromPluginSet = false
      }, 1000)
    }
  }

  async VaultDownImage() {
    this.fromPluginSet = true
    try {
      const files = this.app.vault.getMarkdownFiles()
      this.downloadStatus.total = 0
      this.downloadStatus.current = 0

      const tasks: { file: TFile; downloadTasks: DownTask[] }[] = []

      for (const file of files) {
        const content = await this.app.vault.read(file)
        const fileTasks: DownTask[] = []
        const matches = content.matchAll(markdownImageRegex)

        for (const match of matches) {
          if (!/^http/.test(match[2]) || hasExcludeDomain(match[2], this.settings.excludeDomains)) {
            continue
          }
          let imageAlt = match[3] ? match[3] : match[1] ? match[1] : ""
          imageAlt = imageAlt.replaceAll("\"", "")
          fileTasks.push({
            matchText: match[0],
            imageAlt,
            imageUrl: match[2],
          })
          this.downloadStatus.total++
          statusCheck(this)
        }
        if (fileTasks.length > 0) {
          tasks.push({ file, downloadTasks: fileTasks })
        }
      }

      for (const item of tasks) {
        let fileContent = await this.app.vault.read(item.file)
        let isModify = false

        const downloadResults = await Promise.all(
          item.downloadTasks.map(async (task) => {
            const result = await imageDown(task.imageUrl, this)
            return { task, result }
          })
        )

        for (const { task, result } of downloadResults) {
          if (result.err) {
            showErrorNotice(result.msg)
          } else if (result.path) {
            isModify = true
            this.downloadStatus.current++
            statusCheck(this)
            fileContent = replaceInTextForDownload(fileContent, task.matchText, task.imageAlt, result.path)
          }
        }

        if (isModify) {
          await this.app.vault.modify(item.file, fileContent)
        }
      }
    } finally {
      window.setTimeout(() => {
        this.fromPluginSet = false
      }, 1500)
    }
  }

  async VaultUploadImage() {
    this.fromPluginSet = true
    try {
      const files = this.app.vault.getMarkdownFiles()
      this.uploadStatus.total = 0
      this.uploadStatus.current = 0

      const tasks: { file: TFile; uploadTasks: UploadTask[] }[] = []

      for (const file of files) {
        const content = await this.app.vault.read(file)
        const fileTasks: UploadTask[] = []
        const matches = content.matchAll(wikilinkImageRegex)

        for (const match of matches) {
          const parsedLink = parseWikiImageLink(match[1])
          if (/^http/.test(parsedLink.file)) {
            continue
          }
          const linkFile = parsedLink.file
          const readfile = await getAttachmentUploadPath(linkFile, this)
          if (!readfile) continue

          fileTasks.push({
            matchText: match[0],
            imageAlt: parsedLink.imageAlt,
            imageDisplayText: parsedLink.imageDisplayText,
            imageSize: parsedLink.imageSize,
            imageFile: readfile,
          })
          this.uploadStatus.total++
          statusCheck(this)
        }

        if (fileTasks.length > 0) {
          tasks.push({ file, uploadTasks: fileTasks })
        }
      }

      for (const item of tasks) {
        let fileContent = await this.app.vault.read(item.file)
        let isModify = false

        const uploadResults = await Promise.all(
          item.uploadTasks.map(async (task) => {
            const result = await imageUpload(task.imageFile, this.settings.contentSet, this)
            return { task, result }
          })
        )

        for (const { task, result } of uploadResults) {
          if (result.err) {
            showErrorNotice(result.msg)
          } else if (result.imageUrl) {
            isModify = true
            this.uploadStatus.current++
            statusCheck(this)
            const searchStr = this.settings.uploadImageRandomSearch ? `?${generateRandomString(10)}` : ""
            fileContent = replaceInTextForUpload(fileContent, task.matchText, task.imageAlt, result.imageUrl + searchStr, task.imageDisplayText)
            autoAddExcludeDomain(result.imageUrl, this)
          }
        }

        if (isModify) {
          await this.app.vault.modify(item.file, fileContent)
        }
      }
    } finally {
      window.setTimeout(() => {
        this.fromPluginSet = false
      }, 1500)
    }
  }

  async VaultDeleteUnreferencedImages() {
    const resolvedLinks = this.app.metadataCache.resolvedLinks
    const referencedFiles = new Set<string>()

    for (const sourcePath in resolvedLinks) {
      const links = resolvedLinks[sourcePath]
      for (const targetPath in links) {
        referencedFiles.add(targetPath)
      }
    }

    const markdownFiles = this.app.vault.getMarkdownFiles()
    for (const file of markdownFiles) {
      const cache = this.app.metadataCache.getFileCache(file)
      if (cache) {
        const metadata = metadataCacheHandle(cache, this)
        for (const item of metadata) {
          for (const val of item.value) {
            if (!/^http/.test(val)) {
              const targetFile = this.app.metadataCache.getFirstLinkpathDest(val, file.path)
              if (targetFile) {
                referencedFiles.add(targetFile.path)
              }
            }
          }
        }
      }
    }

    const imageFiles = this.app.vault.getFiles().filter((file) => {
      const ext = file.extension.toLowerCase()
      return ["png", "jpg", "jpeg", "gif", "bmp", "svg", "webp", "avif"].includes(ext)
    })

    let deletedCount = 0
    const unreferencedFiles: TFile[] = []

    for (const file of imageFiles) {
      if (!referencedFiles.has(file.path)) {
        unreferencedFiles.push(file)
      }
    }

    if (unreferencedFiles.length === 0) {
      new Notice($("未发现未引用图片"))
      return
    }

    for (const file of unreferencedFiles) {
      await this.app.fileManager.trashFile(file)
      deletedCount++
    }

    new Notice($("已删除 ${count} 张未引用图片", { count: deletedCount }))
  }

  async loadPluginState() {
    const raw = await this.loadData()

    if (raw && typeof raw === "object" && "settings" in raw) {
      const data = raw as Partial<PersistedPluginData>
      this.settings = Object.assign({}, DEFAULT_SETTINGS, data.settings ?? {})
      this.remoteTrashTasks = {
        pendingTasks: data.remoteTrash?.pendingTasks ?? [],
        historyTasks: data.remoteTrash?.historyTasks ?? [],
      }
      this.deletedNoteRecords = data.deletedNotes ?? []
      return
    }

    this.settings = Object.assign({}, DEFAULT_SETTINGS, raw ?? {})
    this.remoteTrashTasks = structuredClone(DEFAULT_REMOTE_TRASH_STORE)
    this.deletedNoteRecords = []
  }

  async saveSettings(isStatusCheck: boolean = true) {
    await this.savePluginState()
    this.startRemoteTrashTaskPolling()
    if (isStatusCheck) {
      this.resetStatus("none")
    }
  }

  async savePluginState() {
    await this.saveData({
      settings: this.settings,
      remoteTrash: this.remoteTrashTasks,
      deletedNotes: this.deletedNoteRecords,
    } satisfies PersistedPluginData)
  }

  startRemoteTrashTaskPolling() {
    if (this.remoteTrashTimer !== null) {
      window.clearInterval(this.remoteTrashTimer)
    }

    this.remoteTrashTimer = window.setInterval(() => {
      void this.processPendingRemoteTrashTasks()
    }, this.settings.remoteTrashPollIntervalMs)
  }

  canHandleRemoteImageContextMenu(imageUrl: string): boolean {
    if (!imageUrl.startsWith("http://") && !imageUrl.startsWith("https://")) {
      return false
    }

    const activeFile = this.app.workspace.getActiveFile()
    if (!(activeFile instanceof TFile) || activeFile.extension !== "md") {
      return false
    }
    return true
  }

  addDeleteCurrentImageMenuItem(menu: Menu, imageUrl: string) {
    const normalizedImageUrl = this.normalizeRemoteImageUrl(imageUrl)
    if (!this.canHandleRemoteImageContextMenu(normalizedImageUrl)) {
      return
    }

    menu.addItem((item) => {
      item
        .setIcon("trash")
        .setTitle($("删除当前图片"))
        .setWarning(true)
        .onClick(async () => {
          await this.deleteRemoteImageFromCurrentNote(normalizedImageUrl)
        })
    })
  }

  async deleteRemoteImageFromCurrentNote(imageUrl: string) {
    const activeFile = this.app.workspace.getActiveFile()
    if (!(activeFile instanceof TFile)) {
      new Notice($("当前图片引用删除失败"))
      return
    }

    const removalResult = await this.removeRemoteImageReferenceFromFile(activeFile, imageUrl)
    if (!removalResult.removed) {
      new Notice($("未找到当前笔记中的图片引用"))
      return
    }

    const openEditorOverrides = this.getOpenEditorMarkdownOverrides()
    const contentOverrides = {
      ...openEditorOverrides,
      [activeFile.path]: removalResult.normalizedContent,
    }

    const isStillReferenced = await this.isRemoteImageReferencedInVault(imageUrl, { contentOverrides })
    if (isStillReferenced) {
      await this.cancelPendingRemoteTrashTask(imageUrl)
      new Notice($("仅删除当前笔记引用，未创建远端回收任务，因为图片仍被其他位置引用"))
      return
    }

    await this.enqueueRemoteTrashTask(imageUrl, activeFile.path, "single-image-delete")
    new Notice($("已创建远端回收任务，图片将在宽限期后检查并移入 .trash"))
  }

  async captureNoteSnapshot(file: unknown) {
    if (!(file instanceof TFile) || file.extension !== "md") {
      return
    }

    const openOverride = this.getOpenEditorMarkdownOverrides()[file.path]
    if (typeof openOverride === "string") {
      this.noteContentSnapshots[file.path] = openOverride
      return
    }

    try {
      this.noteContentSnapshots[file.path] = await this.app.vault.read(file)
    } catch {
      delete this.noteContentSnapshots[file.path]
    }
  }

  async removeRemoteImageReferenceFromFile(file: TFile, imageUrl: string): Promise<RemoveRemoteImageReferenceResult> {
    const content = this.getOpenEditorMarkdownOverrides()[file.path] ?? await this.app.vault.read(file)
    const removalResult = this.removeRemoteImageReferenceFromMarkdown(content, imageUrl)
    if (!removalResult.removed) {
      return removalResult
    }

    const activeFile = this.app.workspace.getActiveFile()
    const activeEditor = this.app.workspace.activeEditor?.editor

    if (activeFile?.path === file.path && activeEditor) {
      this.fromPluginSet = true
      activeEditor.setValue(removalResult.normalizedContent)
      this.fromPluginSet = false
      return removalResult
    }

    await this.app.vault.modify(file, removalResult.normalizedContent)
    return removalResult
  }

  removeRemoteImageReferenceFromMarkdown(content: string, imageUrl: string): RemoveRemoteImageReferenceResult {
    let removed = false
    const updatedContent = content.replace(markdownImageRegex, (match, altText, url, title) => {
      if (!removed && this.normalizeRemoteImageUrl(url) === imageUrl) {
        removed = true
        return ""
      }
      return match
    })

    return {
      removed,
      normalizedContent: removed ? updatedContent.replace(/\n{3,}/g, "\n\n") : content,
    }
  }

  async enqueueRemoteTrashTask(imageUrl: string, notePath: string, source: RemoteTrashTaskSource, imageRefs?: string[]) {
    const now = Date.now()
    const normalizedImageUrl = this.normalizeRemoteImageUrl(imageUrl)
    const existingTask = this.remoteTrashTasks.pendingTasks.find((task) => task.imageUrl === normalizedImageUrl)

    if (existingTask) {
      existingTask.notePath = notePath
      existingTask.source = source
      existingTask.imageRefs = imageRefs ?? existingTask.imageRefs
      existingTask.createdAt = now
      existingTask.graceUntil = now + this.settings.remoteTrashGraceMs
      existingTask.lastError = ""
      existingTask.finishedAt = null
      existingTask.sourcePath = undefined
      existingTask.trashPath = undefined
      existingTask.restoredAt = null
    } else {
      this.remoteTrashTasks.pendingTasks.push({
        id: this.createTaskId(),
        imageUrl: normalizedImageUrl,
        source,
        notePath,
        imageRefs,
        createdAt: now,
        graceUntil: now + this.settings.remoteTrashGraceMs,
        status: "pending",
        lastError: "",
        finishedAt: null,
        sourcePath: undefined,
        trashPath: undefined,
        restoredAt: null,
      })
    }

    await this.savePluginState()
  }

  async reconcilePendingRemoteTrashTasks() {
    if (this.remoteTrashTasks.pendingTasks.length === 0) {
      return
    }

    const contentOverrides = this.getOpenEditorMarkdownOverrides()
    const cancelledUrls: string[] = []

    for (const task of this.remoteTrashTasks.pendingTasks) {
      const isStillReferenced = await this.isRemoteImageReferencedInVault(task.imageUrl, { contentOverrides })
      if (isStillReferenced) {
        cancelledUrls.push(task.imageUrl)
      }
    }

    if (cancelledUrls.length === 0) {
      return
    }

    let changed = false
    for (const imageUrl of cancelledUrls) {
      const cancelled = this.cancelPendingRemoteTrashTaskInternal(imageUrl)
      changed = changed || cancelled
    }

    if (!changed) {
      return
    }

    this.pruneRemoteTrashHistory()
    await this.savePluginState()
    new Notice($("检测到图片引用已恢复，远端回收任务已取消"))
  }

  async cancelPendingRemoteTrashTask(imageUrl: string, noticeMessage?: string): Promise<boolean> {
    const cancelled = this.cancelPendingRemoteTrashTaskInternal(imageUrl)
    if (!cancelled) {
      return false
    }

    this.pruneRemoteTrashHistory()
    await this.savePluginState()
    if (noticeMessage) {
      new Notice(noticeMessage)
    }
    return true
  }

  cancelPendingRemoteTrashTaskInternal(imageUrl: string): boolean {
    const targetUrl = this.normalizeRemoteImageUrl(imageUrl)
    const pendingTask = this.remoteTrashTasks.pendingTasks.find((task) => task.imageUrl === targetUrl)
    if (!pendingTask) {
      return false
    }

    this.remoteTrashTasks.pendingTasks = this.remoteTrashTasks.pendingTasks.filter((task) => task.imageUrl !== targetUrl)
    this.pushRemoteTrashHistory({
      ...pendingTask,
      status: "cancelled",
      finishedAt: Date.now(),
      lastError: "",
    })
    return true
  }

  async handleVaultDelete(file: unknown) {
    if (!(file instanceof TFile) || file.extension !== "md") {
      return
    }

    const snapshotContent = this.noteContentSnapshots[file.path]
    const cachedMetadata = this.app.metadataCache.getFileCache(file)
    const imageUrls = this.extractRemoteImageUrlsFromNote({
      filePath: file.path,
      content: snapshotContent,
      cache: cachedMetadata ?? undefined,
    })

    delete this.noteContentSnapshots[file.path]

    if (imageUrls.length === 0) {
      this.removeDeletedNoteRecord(file.path)
      return
    }

    this.upsertDeletedNoteRecord(file.path, imageUrls)

    for (const imageUrl of imageUrls) {
      const isStillReferenced = await this.isRemoteImageReferencedInVault(imageUrl, {
        excludeFilePaths: [file.path],
      })
      if (isStillReferenced) {
        continue
      }

      await this.enqueueRemoteTrashTask(imageUrl, file.path, "note-delete", imageUrls)
    }
  }

  async handleVaultCreate(file: unknown) {
    if (!(file instanceof TFile) || file.extension !== "md") {
      return
    }

    await this.captureNoteSnapshot(file)
    await this.handleRestoredNote(file, file.path)
  }

  async handleVaultRename(file: unknown, oldPath: string) {
    if (!(file instanceof TFile) || file.extension !== "md") {
      delete this.noteContentSnapshots[oldPath]
      return
    }

    const existingSnapshot = this.noteContentSnapshots[oldPath]
    if (existingSnapshot) {
      this.noteContentSnapshots[file.path] = existingSnapshot
      delete this.noteContentSnapshots[oldPath]
    }

    const previousRecord = this.deletedNoteRecords.find((item) => item.notePath === oldPath)
    if (previousRecord) {
      await this.captureNoteSnapshot(file)
      await this.handleRestoredNote(file, oldPath)
      return
    }

    await this.captureNoteSnapshot(file)
  }

  async handleRestoredNote(file: TFile, lookupPath: string) {
    const content = this.getOpenEditorMarkdownOverrides()[file.path] ?? await this.app.vault.read(file)
    const restoredImageUrls = this.extractRemoteImageUrlsFromNote({
      filePath: file.path,
      content,
      cache: this.app.metadataCache.getFileCache(file) ?? undefined,
    })

    const deletedRecord = this.deletedNoteRecords.find((item) => item.notePath === lookupPath)
    const candidateImageUrls = Array.from(new Set([...(deletedRecord?.imageUrls ?? []), ...restoredImageUrls]))

    if (candidateImageUrls.length === 0) {
      this.removeDeletedNoteRecord(lookupPath)
      return
    }

    let changed = false
    for (const imageUrl of candidateImageUrls) {
      const cancelled = this.cancelPendingRemoteTrashTaskInternal(imageUrl)
      if (cancelled) {
        changed = true
        continue
      }

      const restored = await this.restoreCompletedRemoteTrashTask(imageUrl, lookupPath)
      changed = changed || restored
    }

    this.removeDeletedNoteRecord(lookupPath)
    if (lookupPath !== file.path) {
      this.removeDeletedNoteRecord(file.path)
    }

    if (changed) {
      this.pruneRemoteTrashHistory()
      await this.savePluginState()
    }
  }

  async restoreCompletedRemoteTrashTask(imageUrl: string, notePath: string): Promise<boolean> {
    const historyTask = this.findLatestRemoteTrashHistoryTask(imageUrl, "completed")
    if (!historyTask?.trashPath || !historyTask.sourcePath) {
      return false
    }

    const restoreResult = await this.requestRemoteRestore(historyTask.imageUrl)
    if (!restoreResult.ok) {
      this.pushRemoteTrashHistory({
        ...historyTask,
        id: this.createTaskId(),
        source: historyTask.source ?? "note-delete",
        notePath,
        status: "failed",
        finishedAt: Date.now(),
        lastError: restoreResult.error,
      })
      new Notice($("远端恢复失败:") + restoreResult.error)
      return false
    }

    this.pushRemoteTrashHistory({
      ...historyTask,
      id: this.createTaskId(),
      notePath,
      status: "restored",
      finishedAt: Date.now(),
      restoredAt: Date.now(),
      lastError: "",
      sourcePath: restoreResult.sourcePath,
      trashPath: restoreResult.trashPath,
    })
    new Notice($("远端图片已恢复"))
    return true
  }

  findLatestRemoteTrashHistoryTask(imageUrl: string, status: RemoteTrashTask["status"]): RemoteTrashTask | undefined {
    const normalizedImageUrl = this.normalizeRemoteImageUrl(imageUrl)
    const matchedTasks = this.remoteTrashTasks.historyTasks
      .filter((task) => task.imageUrl === normalizedImageUrl && task.status === status)
      .sort((left, right) => (right.finishedAt ?? 0) - (left.finishedAt ?? 0))

    return matchedTasks[0]
  }

  upsertDeletedNoteRecord(notePath: string, imageUrls: string[]) {
    const normalizedUrls = Array.from(new Set(imageUrls.map((item) => this.normalizeRemoteImageUrl(item))))
    const existingRecord = this.deletedNoteRecords.find((item) => item.notePath === notePath)
    if (existingRecord) {
      existingRecord.imageUrls = normalizedUrls
      existingRecord.deletedAt = Date.now()
      return
    }

    this.deletedNoteRecords.push({
      notePath,
      imageUrls: normalizedUrls,
      deletedAt: Date.now(),
    })
  }

  removeDeletedNoteRecord(notePath: string) {
    this.deletedNoteRecords = this.deletedNoteRecords.filter((item) => item.notePath !== notePath)
  }

  async processPendingRemoteTrashTasks() {
    if (this.isProcessingRemoteTrashTasks) {
      return
    }

    this.isProcessingRemoteTrashTasks = true
    try {
      const now = Date.now()
      const remainingTasks: RemoteTrashTask[] = []
      const contentOverrides = this.getOpenEditorMarkdownOverrides()

      for (const task of this.remoteTrashTasks.pendingTasks) {
        const isStillReferenced = await this.isRemoteImageReferencedInVault(task.imageUrl, { contentOverrides })
        if (isStillReferenced) {
          this.pushRemoteTrashHistory({
            ...task,
            status: "cancelled",
            finishedAt: Date.now(),
            lastError: "",
          })
          new Notice($("远端回收任务已取消，图片仍被引用"))
          continue
        }

        if (task.graceUntil > now) {
          remainingTasks.push(task)
          continue
        }

        const trashResult = await this.requestRemoteTrash(task.imageUrl)
        if (trashResult.ok) {
          this.pushRemoteTrashHistory({
            ...task,
            status: "completed",
            finishedAt: Date.now(),
            lastError: "",
            sourcePath: trashResult.sourcePath,
            trashPath: trashResult.trashPath,
          })
          new Notice($("远端图片已移入回收站"))
        } else {
          this.pushRemoteTrashHistory({
            ...task,
            status: "failed",
            finishedAt: Date.now(),
            lastError: trashResult.error,
          })
          new Notice($("远端回收失败:") + trashResult.error)
        }
      }

      this.remoteTrashTasks.pendingTasks = remainingTasks
      this.pruneRemoteTrashHistory()
      await this.savePluginState()
    } finally {
      this.isProcessingRemoteTrashTasks = false
    }
  }

  pushRemoteTrashHistory(task: RemoteTrashTask) {
    this.remoteTrashTasks.historyTasks.push(task)
  }

  pruneRemoteTrashHistory() {
    const cutoff = Date.now() - this.settings.remoteTrashHistoryRetentionMs
    this.remoteTrashTasks.historyTasks = this.remoteTrashTasks.historyTasks.filter((task) => {
      return task.finishedAt === null || task.finishedAt >= cutoff
    })
  }

  async isRemoteImageReferencedInVault(imageUrl: string, options?: RemoteImageReferenceSearchOptions): Promise<boolean> {
    const locations = await this.getRemoteImageReferenceLocations(imageUrl, options)
    return locations.length > 0
  }

  extractRemoteImageUrlsFromNote(options: RemoteFileImageExtractOptions): string[] {
    const normalizedUrls = new Set<string>()

    if (typeof options.content === "string") {
      const markdownMatches = options.content.matchAll(markdownImageRegex)
      for (const match of markdownMatches) {
        if (/^https?:\/\//i.test(match[2])) {
          normalizedUrls.add(this.normalizeRemoteImageUrl(match[2]))
        }
      }

      for (const value of this.extractRemoteImageUrlsFromFrontmatter(options.content)) {
        normalizedUrls.add(this.normalizeRemoteImageUrl(value))
      }
    }

    if (options.cache) {
      const metadata = metadataCacheHandle(options.cache, this)
      for (const item of metadata) {
        for (const value of item.value) {
          if (/^https?:\/\//i.test(value)) {
            normalizedUrls.add(this.normalizeRemoteImageUrl(value))
          }
        }
      }
    }

    return Array.from(normalizedUrls)
  }

  async getRemoteImageReferenceLocations(imageUrl: string, options?: RemoteImageReferenceSearchOptions): Promise<RemoteImageReferenceLocation[]> {
    const markdownFiles = this.app.vault.getMarkdownFiles()
    const normalizedImageUrl = this.normalizeRemoteImageUrl(imageUrl)
    const contentOverrides = options?.contentOverrides ?? {}
    const excludedPaths = new Set(options?.excludeFilePaths ?? [])
    const locations: RemoteImageReferenceLocation[] = []

    for (const file of markdownFiles) {
      if (excludedPaths.has(file.path)) {
        continue
      }

      const hasContentOverride = Object.prototype.hasOwnProperty.call(contentOverrides, file.path)
      const content = hasContentOverride ? contentOverrides[file.path] : await this.app.vault.read(file)
      const markdownMatches = content.matchAll(markdownImageRegex)
      for (const match of markdownMatches) {
        if (this.normalizeRemoteImageUrl(match[2]) === normalizedImageUrl) {
          locations.push({ filePath: file.path, kind: "markdown" })
          break
        }
      }

      const frontmatterValues = this.extractRemoteImageUrlsFromFrontmatter(content)
      if (frontmatterValues.some((value) => this.normalizeRemoteImageUrl(value) === normalizedImageUrl)) {
        locations.push({ filePath: file.path, kind: "metadata" })
        continue
      }

      if (hasContentOverride) {
        continue
      }

      const cache = this.app.metadataCache.getFileCache(file)
      if (!cache) continue

      const metadata = metadataCacheHandle(cache, this)
      for (const item of metadata) {
        for (const value of item.value) {
          if (/^https?:\/\//i.test(value) && this.normalizeRemoteImageUrl(value) === normalizedImageUrl) {
            locations.push({ filePath: file.path, kind: "metadata" })
            break
          }
        }
      }
    }

    return locations
  }

  getOpenEditorMarkdownOverrides(): Record<string, string> {
    const overrides: Record<string, string> = {}

    for (const leaf of this.app.workspace.getLeavesOfType("markdown")) {
      if (!(leaf.view instanceof MarkdownView)) {
        continue
      }

      const file = leaf.view.file
      const editor = leaf.view.editor
      if (!(file instanceof TFile) || file.extension !== "md" || !editor) {
        continue
      }

      overrides[file.path] = editor.getValue()
    }

    return overrides
  }

  extractRemoteImageUrlsFromFrontmatter(content: string): string[] {
    const frontmatter = this.extractFrontmatterBlock(content)
    if (!frontmatter) {
      return []
    }

    const wantedKeys = new Set(this.settings.propertyNeedSets.map((item) => item.key))
    if (wantedKeys.size === 0) {
      return []
    }

    const lines = frontmatter.split("\n")
    const values: string[] = []

    for (let index = 0; index < lines.length; index++) {
      const line = lines[index]
      const keyMatch = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line)
      if (!keyMatch) {
        continue
      }

      const [, key, rawValue] = keyMatch
      if (!wantedKeys.has(key)) {
        continue
      }

      if (rawValue.trim() !== "") {
        values.push(...this.extractRemoteImageUrlsFromYamlValue(rawValue))
        continue
      }

      const listValues: string[] = []
      for (let nestedIndex = index + 1; nestedIndex < lines.length; nestedIndex++) {
        const nestedLine = lines[nestedIndex]
        if (/^\S/.test(nestedLine)) {
          break
        }

        const listMatch = /^\s*-\s+(.*)$/.exec(nestedLine)
        if (listMatch) {
          listValues.push(...this.extractRemoteImageUrlsFromYamlValue(listMatch[1]))
        }
      }
      values.push(...listValues)
    }

    return values
  }

  extractFrontmatterBlock(content: string): string | null {
    if (!content.startsWith("---\n")) {
      return null
    }

    const endIndex = content.indexOf("\n---", 4)
    if (endIndex === -1) {
      return null
    }

    return content.slice(4, endIndex)
  }

  extractRemoteImageUrlsFromYamlValue(rawValue: string): string[] {
    const trimmed = rawValue.trim()
    if (trimmed === "") {
      return []
    }

    if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
      return trimmed
        .slice(1, -1)
        .split(",")
        .flatMap((part) => this.extractRemoteImageUrlsFromYamlValue(part))
    }

    const unquoted = trimmed.replace(/^['"]|['"]$/g, "")
    return /^https?:\/\//i.test(unquoted) ? [unquoted] : []
  }

  async requestRemoteTrash(imageUrl: string): Promise<{ ok: boolean; error: string; sourcePath?: string; trashPath?: string }> {
    const apiUrl = this.buildRemoteImageLifecycleApiUrl("trash")
    const headers = new Headers({ "Content-Type": "application/json" })
    if (this.settings.apiToken !== "") {
      headers.set("Authorization", this.settings.apiToken)
    }

    const body: Record<string, string> = { imageUrl }
    if (this.settings.uploadConfigId.trim() !== "") {
      body.id = this.settings.uploadConfigId.trim()
    }

    try {
      const response = await fetch(apiUrl, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
      })

      const rawText = await response.text()
      let result: { status?: boolean; message?: string; details?: string | string[]; data?: { sourcePath?: string; trashPath?: string } } = {}
      try {
        result = rawText ? JSON.parse(rawText) : {}
      } catch {
        result = { message: rawText }
      }

      if (!response.ok || result.status === false) {
        const detailsText = Array.isArray(result.details) ? result.details.join(",") : (result.details ?? "")
        return {
          ok: false,
          error: `${result.message ?? response.statusText}${detailsText ? ` ${detailsText}` : ""}`.trim(),
        }
      }

      return {
        ok: true,
        error: "",
        sourcePath: result.data?.sourcePath,
        trashPath: result.data?.trashPath,
      }
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : $("网络错误,请检查网络是否通畅"),
      }
    }
  }

  async requestRemoteRestore(imageUrl: string): Promise<{ ok: boolean; error: string; sourcePath?: string; trashPath?: string }> {
    const apiUrl = this.buildRemoteImageLifecycleApiUrl("restore")
    const headers = new Headers({ "Content-Type": "application/json" })
    if (this.settings.apiToken !== "") {
      headers.set("Authorization", this.settings.apiToken)
    }

    const body: Record<string, string> = { imageUrl }
    if (this.settings.uploadConfigId.trim() !== "") {
      body.id = this.settings.uploadConfigId.trim()
    }

    try {
      const response = await fetch(apiUrl, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
      })

      const rawText = await response.text()
      let result: { status?: boolean; message?: string; details?: string | string[]; data?: { sourcePath?: string; trashPath?: string } } = {}
      try {
        result = rawText ? JSON.parse(rawText) : {}
      } catch {
        result = { message: rawText }
      }

      if (!response.ok || result.status === false) {
        const detailsText = Array.isArray(result.details) ? result.details.join(",") : (result.details ?? "")
        return {
          ok: false,
          error: `${result.message ?? response.statusText}${detailsText ? ` ${detailsText}` : ""}`.trim(),
        }
      }

      return {
        ok: true,
        error: "",
        sourcePath: result.data?.sourcePath,
        trashPath: result.data?.trashPath,
      }
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : $("网络错误,请检查网络是否通畅"),
      }
    }
  }

  buildRemoteImageLifecycleApiUrl(action: "trash" | "restore"): string {
    const apiUrl = new URL(this.settings.api)
    const pathname = apiUrl.pathname.replace(/\/+$/, "")

    if (pathname.endsWith("/user/upload")) {
      apiUrl.pathname = pathname.replace(/\/user\/upload$/, `/user/image/${action}`)
    } else if (pathname.endsWith("/upload")) {
      apiUrl.pathname = pathname.replace(/\/upload$/, `/image/${action}`)
    } else {
      apiUrl.pathname = `${pathname}/image/${action}`
    }

    apiUrl.search = ""
    apiUrl.hash = ""
    return apiUrl.toString()
  }

  normalizeRemoteImageUrl(imageUrl: string): string {
    try {
      const url = new URL(imageUrl)
      url.hash = ""
      url.search = ""
      return url.toString()
    } catch {
      return imageUrl.trim()
    }
  }

  createTaskId(): string {
    return `remote-trash-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  }
}
