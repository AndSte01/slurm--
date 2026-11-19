import * as assert from 'assert';

// You can import and use all API from the 'vscode' module
// as well as import your extension to test it
import * as vscode from 'vscode';
import { Task, TaskState } from '../models';
// import * as myExtension from '../../extension';

suite('Extension Test Suite', () => {
	vscode.window.showInformationMessage('Start all tests.');

	test('Sample test', () => {
		assert.strictEqual(-1, [1, 2, 3].indexOf(5));
		assert.strictEqual(-1, [1, 2, 3].indexOf(0));
	});

	test('Task cluster survives cache serialization', () => {
		const task = new Task({
			jobid: 42,
			arrayid: null,
			name: 'cluster-task',
			user: 'user',
			cluster: 'alpha',
			state: TaskState.R,
			node: 'node-1',
			gres: null,
			limitTime: '01:00:00',
			runningTime: '00:01:00',
			command: 'echo test',
			outPath: 'stdout.txt',
			errPath: 'stderr.txt',
			reason: '',
			submitTime: '2026-01-01T00:00:00',
		});

		assert.strictEqual(Task.fromObj(task.toObj()).cluster, 'alpha');
	});
});
