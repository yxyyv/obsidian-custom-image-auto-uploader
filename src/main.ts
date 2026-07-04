import { Menu, Notice, Plugin, TFile, debounce } from "obsidian";

import {
  autoAddExcludeDomain,
  generateRandomString,
  getAttachmentUploadPath,
  hasExcludeDomain,
  imageDown,
  imageUpload,
  metadataCacheHandle,
  replaceInTextForDownload,
  replaceInTextForUpload,
  setMenu,
  showErrorNotice,
  showTaskNotice,
  statusCheck,
} from "./lib/utils";
import { DownTask, RemoteTrashTask, RemoteTrashTaskStore, UploadTask } from "./lib/interface";
import { DEFAULT_SETTINGS, PluginSettings, SettingTab } from "./setting";
import { $ } from "./lang/lang";

const wikilinkImageRegex = /!\[\[([^\]|]*)\|?([^\]]*)\]\]/g;
const markdownImageRegex = /!\[([^\]]*)\]\((.*?)\s*("(?:.*[^"])")?\s*\)/g;

interface PersistedPluginData {
  settings: PluginSettings
  remoteTrash: RemoteTrashTaskStore
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
      },
      1000,
      true
    )

    this.registerEvent(this.app.workspace.on("editor-change", debouncedProcess))

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

    this.addRibbonIcon("image", "Custom Image Auto Uploader", (event) => {
      const menu = new Menu()
      setMenu(menu, this, true)
      menu.showAtMouseEvent(event)
    })

    this.registerDomEvent(document, "contextmenu", (event: MouseEvent) => {
      this.handleImageContextMenu(event)
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

      if (/^http/.test(match[1])) {
        continue
      }

      const file = match[1]
      const readfile = await getAttachmentUploadPath(file, this)
      if (!readfile) continue

      const imageAlt = match[2] ? match[2] : file
      uploadTasks.push({
        matchText: match[0],
        imageAlt,
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
        fileContent = replaceInTextForUpload(fileContent, task.matchText, task.imageAlt, result.imageUrl + searchStr)
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
          if (/^http/.test(match[1])) {
            continue
          }
          const linkFile = match[1]
          const readfile = await getAttachmentUploadPath(linkFile, this)
          if (!readfile) continue

          const imageAlt = match[2] ? match[2] : linkFile
          fileTasks.push({
            matchText: match[0],
            imageAlt,
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
            fileContent = replaceInTextForUpload(fileContent, task.matchText, task.imageAlt, result.imageUrl + searchStr)
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
      return
    }

    this.settings = Object.assign({}, DEFAULT_SETTINGS, raw ?? {})
    this.remoteTrashTasks = structuredClone(DEFAULT_REMOTE_TRASH_STORE)
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

  handleImageContextMenu(event: MouseEvent) {
    const target = event.target
    if (!(target instanceof HTMLElement)) return

    const imageElement = target.closest("img")
    if (!(imageElement instanceof HTMLImageElement)) return

    const imageUrl = this.normalizeRemoteImageUrl(imageElement.currentSrc || imageElement.src)
    if (!this.canHandleRemoteImageContextMenu(imageElement, imageUrl)) return

    event.preventDefault()
    event.stopPropagation()

    const menu = new Menu()
    menu.addItem((item) => {
      item
        .setIcon("trash")
        .setTitle($("删除图片并延迟移到远端回收站"))
        .onClick(async () => {
          await this.deleteRemoteImageFromCurrentNote(imageUrl)
        })
    })
    menu.showAtMouseEvent(event)
  }

  canHandleRemoteImageContextMenu(imageElement: HTMLImageElement, imageUrl: string): boolean {
    if (!imageUrl.startsWith("http://") && !imageUrl.startsWith("https://")) {
      return false
    }

    const activeFile = this.app.workspace.getActiveFile()
    if (!(activeFile instanceof TFile) || activeFile.extension !== "md") {
      return false
    }

    const sourceViewContainer = imageElement.closest(".markdown-source-view, .cm-content")
    const readingViewContainer = imageElement.closest(".markdown-preview-view, .markdown-reading-view")
    return sourceViewContainer !== null || readingViewContainer !== null
  }

  async deleteRemoteImageFromCurrentNote(imageUrl: string) {
    const activeFile = this.app.workspace.getActiveFile()
    if (!(activeFile instanceof TFile)) {
      new Notice($("当前图片引用删除失败"))
      return
    }

    const removed = await this.removeRemoteImageReferenceFromFile(activeFile, imageUrl)
    if (!removed) {
      new Notice($("未找到当前笔记中的图片引用"))
      return
    }

    await this.enqueueRemoteTrashTask(imageUrl, activeFile.path)
    new Notice($("已创建远端回收任务，图片将在宽限期后检查并移入 .trash"))
  }

  async removeRemoteImageReferenceFromFile(file: TFile, imageUrl: string): Promise<boolean> {
    const content = await this.app.vault.read(file)
    let removed = false
    const updatedContent = content.replace(markdownImageRegex, (match, altText, url, title) => {
      if (!removed && this.normalizeRemoteImageUrl(url) === imageUrl) {
        removed = true
        return ""
      }
      return match
    })

    if (!removed) {
      return false
    }

    const normalizedContent = updatedContent.replace(/\n{3,}/g, "\n\n")
    const activeFile = this.app.workspace.getActiveFile()
    const activeEditor = this.app.workspace.activeEditor?.editor

    if (activeFile?.path === file.path && activeEditor) {
      this.fromPluginSet = true
      activeEditor.setValue(normalizedContent)
      this.fromPluginSet = false
      return true
    }

    await this.app.vault.modify(file, normalizedContent)
    return true
  }

  async enqueueRemoteTrashTask(imageUrl: string, notePath: string) {
    const now = Date.now()
    const existingTask = this.remoteTrashTasks.pendingTasks.find((task) => task.imageUrl === imageUrl)

    if (existingTask) {
      existingTask.notePath = notePath
      existingTask.createdAt = now
      existingTask.graceUntil = now + this.settings.remoteTrashGraceMs
      existingTask.lastError = ""
    } else {
      this.remoteTrashTasks.pendingTasks.push({
        id: this.createTaskId(),
        imageUrl,
        notePath,
        createdAt: now,
        graceUntil: now + this.settings.remoteTrashGraceMs,
        status: "pending",
        lastError: "",
        finishedAt: null,
      })
    }

    await this.savePluginState()
  }

  async processPendingRemoteTrashTasks() {
    if (this.isProcessingRemoteTrashTasks) {
      return
    }

    this.isProcessingRemoteTrashTasks = true
    try {
      const now = Date.now()
      const remainingTasks: RemoteTrashTask[] = []

      for (const task of this.remoteTrashTasks.pendingTasks) {
        if (task.graceUntil > now) {
          remainingTasks.push(task)
          continue
        }

        const isStillReferenced = await this.isRemoteImageReferencedInVault(task.imageUrl)
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

        const trashResult = await this.requestRemoteTrash(task.imageUrl)
        if (trashResult.ok) {
          this.pushRemoteTrashHistory({
            ...task,
            status: "completed",
            finishedAt: Date.now(),
            lastError: "",
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

  async isRemoteImageReferencedInVault(imageUrl: string): Promise<boolean> {
    const markdownFiles = this.app.vault.getMarkdownFiles()

    for (const file of markdownFiles) {
      const content = await this.app.vault.read(file)
      const markdownMatches = content.matchAll(markdownImageRegex)
      for (const match of markdownMatches) {
        if (this.normalizeRemoteImageUrl(match[2]) === imageUrl) {
          return true
        }
      }

      const cache = this.app.metadataCache.getFileCache(file)
      if (!cache) continue

      const metadata = metadataCacheHandle(cache, this)
      for (const item of metadata) {
        for (const value of item.value) {
          if (/^https?:\/\//i.test(value) && this.normalizeRemoteImageUrl(value) === imageUrl) {
            return true
          }
        }
      }
    }

    return false
  }

  async requestRemoteTrash(imageUrl: string): Promise<{ ok: boolean; error: string }> {
    const apiUrl = this.buildRemoteTrashApiUrl()
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
      let result: { status?: boolean; message?: string; details?: string | string[] } = {}
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

      return { ok: true, error: "" }
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : $("网络错误,请检查网络是否通畅"),
      }
    }
  }

  buildRemoteTrashApiUrl(): string {
    const apiUrl = new URL(this.settings.api)
    const pathname = apiUrl.pathname.replace(/\/+$/, "")

    if (pathname.endsWith("/user/upload")) {
      apiUrl.pathname = pathname.replace(/\/user\/upload$/, "/user/image/trash")
    } else if (pathname.endsWith("/upload")) {
      apiUrl.pathname = pathname.replace(/\/upload$/, "/image/trash")
    } else {
      apiUrl.pathname = `${pathname}/image/trash`
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
