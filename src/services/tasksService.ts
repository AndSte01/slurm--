import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';

import { BaseTask, loadObj, Task, TaskArray, TaskObjTypes, TaskState } from '../models';
import { executeCmd } from '../utils/utils';
import { configService } from './configService';
import { ensureSlurmCommand } from './commandAvailability';
import { clearQueryFailure, reportQuery } from './queryStatus';
import * as shellQuote from 'shell-quote';

function taskKey(task: BaseTask): string {
    return `${task.cluster ?? ''}:${task.jobid}`;
}

function taskRecordKey(cluster: string | null, jobArrayId: string): string {
    return `${cluster ?? ''}:${jobArrayId}`;
}


function parseJobarrayId(jobIdStr: string): string[] {
    const fullJobMatch = /^(\d+)$/.exec(jobIdStr);
    if (fullJobMatch) {
        return [jobIdStr];
    }

    const singleTaskMatch = /^(\d+)_(\d+)$/.exec(jobIdStr);
    if (singleTaskMatch) {
        return [jobIdStr];
    }

    const bracketMatch = /^(\d+)_\[(.+?)(?:%\d+)?\]$/.exec(jobIdStr);
    if (bracketMatch) {
        const jobId = bracketMatch[1];
        const content = bracketMatch[2];

        const values = parseArrayTaskSpec(content);
        if (values.length > 0) {
            return values.map((v) => `${jobId}_${v}`);
        }
    }

    return [];
}

function parseArrayTaskSpec(content: string): number[] {
    const result: number[] = [];

    for (const part of content.split(',')) {
        const match = /^(\d+)(?:-(\d+)(?::(\d+))?)?$/.exec(part);
        if (!match) {
            return [];
        }

        const start = parseInt(match[1], 10);
        const end = match[2] ? parseInt(match[2], 10) : start;
        const step = match[3] ? parseInt(match[3], 10) : 1;
        if (isNaN(start) || isNaN(end) || isNaN(step) || start > end || step <= 0) {
            return [];
        }

        for (let i = start; i <= end; i += step) {
            result.push(i);
        }
    }

    return result;
}

interface TaskFinishInfo {
    endTime: string;
    exitCode: string;
    state: string;
}

async function getTaskFinishInfo(tasks: Task[], background: boolean): Promise<Map<string, TaskFinishInfo>> {
    if (tasks.length === 0) { clearQueryFailure('sacct'); return new Map(); }
    if (!await ensureSlurmCommand('sacct', background)) {
        reportQuery('sacct', vscode.l10n.t('Command unavailable.'), background, false);
        return new Map();
    }

    const finishInfoMap: Map<string, TaskFinishInfo> = new Map();
    const terminalStates = new Set(['COMPLETED', 'FAILED', 'CANCELLED', 'TIMEOUT', 'NODE_FAIL', 'OUT_OF_MEMORY', 'BOOT_FAIL', 'DEADLINE', 'PREEMPTED', 'REVOKED']);
    const clusterTasks = new Map<string | null, Task[]>();
    tasks.forEach(task => {
        if (!clusterTasks.has(task.cluster)) {
            clusterTasks.set(task.cluster, []);
        }
        clusterTasks.get(task.cluster)!.push(task);
    });

    const errors: string[] = [];
    for (const [cluster, clusterTaskList] of clusterTasks) {
        const jobIds = [...new Set(clusterTaskList.map(task => task.jobArrayId))];
        const clusterArg = cluster ? ` --clusters=${shellQuote.quote([cluster])}` : '';
        const { stdout: out, error: err } = await executeCmd(`${configService.getSlurmCommand('sacct')}${clusterArg} -n -X -P -j ${jobIds.join(',')} --format=JobID,End,ExitCode,State%30`);
        if (err) {
            errors.push(err);
            continue;
        }
        out.split('\n').forEach(line => {
            const [jobid, time, exitCode, state] = line.split('|');
            const finalState = state?.trim().split(' ')[0];
            if (!time || time === 'Unknown' || !exitCode || !terminalStates.has(finalState)) { return; }
            parseJobarrayId(jobid).forEach(jobArrayId => {
                finishInfoMap.set(taskRecordKey(cluster, jobArrayId), { endTime: time, exitCode, state: finalState });
            });
        });
    }

    if (errors.length > 0) {
        reportQuery('sacct', errors.join('\n'), background);
    } else {
        reportQuery('sacct');
    }
    return finishInfoMap;
}


export class TaskService {
    private storagePath;
    private taskMap!: Map<string, BaseTask>;

    private isSaving = false;
    private pendingSave = false;

    private static _instance: TaskService | null = null;
    private constructor(context: vscode.ExtensionContext) {
        this.storagePath = path.join(context.globalStorageUri.fsPath, 'tasks.json');
        const dir = path.dirname(this.storagePath);
        fs.mkdirSync(dir, { recursive: true });
        this.loadTask();
    }

    static getInstance(context?: vscode.ExtensionContext): TaskService {
        if (TaskService._instance === null) {
            if (context === undefined) {
                throw new Error(`init ${this.name} failed.`);
            }
            TaskService._instance = new TaskService(context);
        }
        return TaskService._instance;
    }

    private loadTask() {
        this.taskMap = new Map();

        if (fs.existsSync(this.storagePath)) {
            try {
                let jsonData = fs.readFileSync(this.storagePath, 'utf8');
                if (jsonData === '') { jsonData = '[]'; }
                const saveMap = JSON.parse(jsonData);
                const taskMap = new Map(saveMap) as Map<string | number, TaskObjTypes>;

                taskMap.forEach(v => {
                    const loaded = loadObj(v);
                    if (loaded !== null) {
                        this.taskMap.set(taskKey(loaded), loaded);
                    }
                });
            } catch (err) {
                fs.unlinkSync(this.storagePath);
                vscode.window.showWarningMessage(vscode.l10n.t('The task cache file appears to be corrupted and has been automatically removed. Finished tasks may be lost.'));
            }
        }
    }

    private async saveTask() {
        if (this.isSaving) {
            this.pendingSave = true;
            return;
        }

        this.isSaving = true;
        try {
            const arrData = Array.from(this.taskMap.entries()).map(([key, task]) => ([
                key,
                task.toObj()
            ]));
            const jsonData = JSON.stringify(arrData);

            const tempPath = this.storagePath + '.tmp';
            fs.writeFileSync(tempPath, jsonData, 'utf8');

            fs.renameSync(tempPath, this.storagePath);
        } finally {
            this.isSaving = false;
            if (this.pendingSave) {
                this.pendingSave = false;
                this.saveTask();
            }
        }
    }

    private async finishTask(tasks: Task[], background: boolean) {
        const finishInfoMap = await getTaskFinishInfo(tasks, background);
        const arrayFinishes = new Map<TaskArray, {
            endTimes: Record<number, string>,
            exitCodes: Record<number, string>,
            states: Record<number, string>,
        }>();
        for (const task of tasks) {
            const info = finishInfoMap.get(taskRecordKey(task.cluster, task.jobArrayId));
            if (!info) { continue; }
            const parent = this.taskMap.get(taskKey(task));
            if (task.arrayid !== null && parent instanceof TaskArray) {
                let finishes = arrayFinishes.get(parent);
                if (!finishes) {
                    finishes = { endTimes: {}, exitCodes: {}, states: {} };
                    arrayFinishes.set(parent, finishes);
                }
                finishes.endTimes[task.arrayid!] = info.endTime;
                finishes.exitCodes[task.arrayid!] = info.exitCode;
                finishes.states[task.arrayid!] = info.state;
            } else {
                task.finish(info.endTime, info.exitCode, info.state);
            }
        }
        arrayFinishes.forEach((finishes, taskArray) => {
            taskArray.finish(finishes.endTimes, finishes.exitCodes, finishes.states);
        });
    }

    public addTask(...tasks: BaseTask[]) {
        tasks.forEach(value => this.taskMap.set(taskKey(value), value));
        this.saveTask();
    }

    public async updateTask(tasks: BaseTask[], background = false) {
        this.loadTask();
        tasks.forEach(task => {
            const key = taskKey(task);
            const existing = this.taskMap.get(key);
            if (existing) {
                existing.update(task);
            } else {
                this.taskMap.set(key, task);
            }
        });

        const newTaskIds = new Set(tasks.flatMap(task => task instanceof TaskArray ? task.getSubTasks() : [task as Task])
            .map(task => taskRecordKey(task.cluster, task.jobArrayId)));
        const existingTasks = [...this.taskMap.values()]
            .flatMap(task => task instanceof TaskArray ? task.getSubTasks() : [task as Task])
            .filter(task => !task.finished);
        const dropTasks = existingTasks.filter(task => !newTaskIds.has(taskRecordKey(task.cluster, task.jobArrayId)));
        dropTasks.forEach(task => { task.state = TaskState.AWAITING_ACCOUNTING; });

        await this.finishTask(dropTasks, background);

        this.saveTask();
    }

    public deleteTask(task: BaseTask | number, arrayId?: number | null): void {
        const taskKeyValue = typeof task === "number"
            ? [...this.taskMap].find(([, value]) => value.jobid === task)?.[0]
            : taskKey(task);
        if (taskKeyValue === undefined) { return; }
        if (arrayId === undefined || arrayId === null) {
            this.taskMap.delete(taskKeyValue);
        } else {
            const array = this.taskMap.get(taskKeyValue) as TaskArray;
            delete array.subTasks[arrayId];
            if (Object.keys(array.subTasks).length === 0) {
                this.taskMap.delete(taskKeyValue);
            }
        }
        this.saveTask();
    }

    public getTask(): BaseTask[] {
        return [...this.taskMap.values()];
    }
}

export let taskService: TaskService;

export function initTaskService(context: vscode.ExtensionContext) {
    taskService = TaskService.getInstance(context);
}
