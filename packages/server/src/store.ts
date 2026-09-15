import { EventEmitter } from 'node:events';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ARTIFACTS_DIR, JOBS_PATH, MAX_JOBS } from './config';
import type { Job, JobEvent } from './types';

/** 持久化到 jobs.json 时剥离的大字段（markdown 内容实时从磁盘读取） */
type PersistedJob = Omit<Job, 'events' | 'markdown'> & {
  events: JobEvent[];
  markdown?: string;
};

class JobStore {
  private jobs = new Map<string, Job>();
  readonly emitter = new EventEmitter();

  constructor() {
    this.emitter.setMaxListeners(0);
    this.restore();
  }

  private restore(): void {
    try {
      if (!existsSync(JOBS_PATH)) return;
      const rows = JSON.parse(readFileSync(JOBS_PATH, 'utf-8')) as PersistedJob[];
      for (const row of rows.slice(-MAX_JOBS)) {
        // 重启后中断的运行中任务标记为失败
        if (row.status === 'running' || row.status === 'pending') {
          row.status = 'failed';
          row.error = row.error ?? '服务重启，任务中断';
        }
        this.jobs.set(row.id, row);
      }
    } catch {
      /* 忽略损坏的历史文件 */
    }
  }

  private persistTimer?: NodeJS.Timeout;

  private schedulePersist(): void {
    if (this.persistTimer) return;
    this.persistTimer = setTimeout(() => {
      this.persistTimer = undefined;
      this.persist();
    }, 400);
  }

  private persist(): void {
    try {
      const rows = this.list().map((j) => {
        // 不落盘 markdown 全文，避免历史文件膨胀；预览接口从产物文件读取
        const { markdown: _markdown, ...rest } = j;
        return rest;
      });
      writeFileSync(JOBS_PATH, JSON.stringify(rows, null, 2), 'utf-8');
    } catch {
      /* 持久化失败不影响主流程 */
    }
  }

  create(job: Job): void {
    this.jobs.set(job.id, job);
    this.schedulePersist();
  }

  get(id: string): Job | undefined {
    return this.jobs.get(id);
  }

  update(id: string, patch: Partial<Job>): Job | undefined {
    const job = this.jobs.get(id);
    if (!job) return undefined;
    Object.assign(job, patch, { updatedAt: Date.now() });
    this.schedulePersist();
    return job;
  }

  addEvent(id: string, event: JobEvent): void {
    const job = this.jobs.get(id);
    if (!job) return;
    job.events.push(event);
    job.updatedAt = Date.now();
    this.emitter.emit(`job:${id}`, event);
    this.schedulePersist();
  }

  /** 订阅任务事件，立即回放历史事件 */
  subscribe(id: string, listener: (e: JobEvent) => void): () => void {
    const job = this.jobs.get(id);
    if (job) {
      for (const e of job.events) listener(e);
    }
    this.emitter.on(`job:${id}`, listener);
    return () => this.emitter.off(`job:${id}`, listener);
  }

  list(): Job[] {
    return [...this.jobs.values()].sort((a, b) => b.createdAt - a.createdAt);
  }

  remove(id: string): boolean {
    const ok = this.jobs.delete(id);
    if (ok) this.schedulePersist();
    return ok;
  }

  artifactDir(id: string): string {
    return join(ARTIFACTS_DIR, id);
  }
}

export const store = new JobStore();
