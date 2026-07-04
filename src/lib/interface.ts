import { TFile } from "obsidian";

import { UploadSet } from "../setting";


export interface Metadata {
  key: string
  type: string
  value: Array<string>
  params: UploadSet
}

export interface DownTask {
  matchText: string // 原始匹配文本
  imageAlt: string // 图片替代文本
  imageUrl: string // 图片URL
  metadataItem?: Metadata
}

export interface UploadTask {
  matchText: string // 原始匹配文本
  imageAlt: string // 图片替代文本
  imageFile: TFile // 图片路径
  metadataItem?: Metadata
}

export type RemoteTrashTaskStatus = "pending" | "completed" | "cancelled" | "failed"

export interface RemoteTrashTask {
  id: string
  imageUrl: string
  notePath: string
  createdAt: number
  graceUntil: number
  status: RemoteTrashTaskStatus
  lastError: string
  finishedAt: number | null
}

export interface RemoteTrashTaskStore {
  pendingTasks: RemoteTrashTask[]
  historyTasks: RemoteTrashTask[]
}
