// Copyright (c) 2026 Aayush Chawla
// SPDX-License-Identifier: MIT

// In-app updates. The Tauri updater plugin reads `latest.json` from the
// newest GitHub release, compares its version with the running app and, when
// the user agrees, downloads the platform bundle, verifies its signature
// against the public key in tauri.conf.json and installs it. A restart then
// runs the new version. Outside Tauri (the browser mock) nothing happens.

import type { Update } from '@tauri-apps/plugin-updater';
import { inTauri } from '$lib/api/client';

export type UpdateStatus = 'idle' | 'checking' | 'available' | 'downloading' | 'ready' | 'error';
export type CheckResult = 'available' | 'up-to-date' | 'error';

/** Checked a few seconds after launch so startup is not slowed, then every
 * two hours while the app stays open. */
const STARTUP_DELAY_MS = 5000;
const PERIODIC_INTERVAL_MS = 2 * 60 * 60 * 1000;

class UpdaterState {
	status = $state<UpdateStatus>('idle');
	/** The newer version on offer while `status` is available or later. */
	version = $state<string | null>(null);
	/** Release notes for that version, if the release body had any. */
	notes = $state<string | null>(null);
	/** Download progress in percent while `status` is downloading. */
	progress = $state(0);
	error = $state<string | null>(null);
	lastCheckedAt = $state<number | null>(null);
	/** The running app's version, read once when the updater starts. */
	currentVersion = $state<string | null>(null);
	/** The rail banner stays hidden after the user closes it, until a
	 * different version turns up. */
	dismissed = $state(false);

	private update: Update | null = null;
	private startupTimer: ReturnType<typeof setTimeout> | undefined;
	private periodicTimer: ReturnType<typeof setInterval> | undefined;

	/** True in the desktop app, where the plugin exists. */
	get supported(): boolean {
		return inTauri();
	}

	/** An update is on offer and nothing is in flight. */
	get available(): boolean {
		return this.status === 'available';
	}

	/** Reads the app version and schedules the automatic checks. */
	async start(): Promise<void> {
		if (!this.supported) return;
		this.stop();
		try {
			const { getVersion } = await import('@tauri-apps/api/app');
			this.currentVersion = await getVersion();
		} catch {
			this.currentVersion = null;
		}
		this.startupTimer = setTimeout(() => {
			void this.check();
			this.periodicTimer = setInterval(() => void this.check(), PERIODIC_INTERVAL_MS);
		}, STARTUP_DELAY_MS);
	}

	stop(): void {
		clearTimeout(this.startupTimer);
		clearInterval(this.periodicTimer);
		this.startupTimer = undefined;
		this.periodicTimer = undefined;
	}

	/** Asks the release endpoint for a newer version. A check never
	 * interrupts a download or a pending install. */
	async check(): Promise<CheckResult> {
		if (!this.supported) return 'error';
		if (this.status === 'downloading' || this.status === 'ready') return 'available';
		this.status = 'checking';
		this.error = null;
		try {
			const { check } = await import('@tauri-apps/plugin-updater');
			const update = await check();
			this.lastCheckedAt = Date.now();
			if (!update) {
				this.update = null;
				this.version = null;
				this.notes = null;
				this.status = 'idle';
				return 'up-to-date';
			}
			if (update.version !== this.version) this.dismissed = false;
			this.update = update;
			this.version = update.version;
			this.notes = update.body ?? null;
			this.status = 'available';
			return 'available';
		} catch (e) {
			this.lastCheckedAt = Date.now();
			this.status = 'error';
			this.error = e instanceof Error ? e.message : String(e);
			return 'error';
		}
	}

	/** Downloads and installs the offered update. The new version runs
	 * after `relaunch`. */
	async install(): Promise<void> {
		const update = this.update;
		if (!update || this.status === 'downloading') return;
		this.status = 'downloading';
		this.progress = 0;
		this.error = null;
		let total = 0;
		let received = 0;
		try {
			await update.downloadAndInstall((event) => {
				if (event.event === 'Started') {
					total = event.data.contentLength ?? 0;
				} else if (event.event === 'Progress') {
					received += event.data.chunkLength;
					this.progress = total > 0 ? Math.min(100, Math.round((received / total) * 100)) : 0;
				} else if (event.event === 'Finished') {
					this.progress = 100;
				}
			});
			this.status = 'ready';
		} catch (e) {
			this.status = 'error';
			this.error = e instanceof Error ? e.message : String(e);
		}
	}

	/** Restarts the app so the installed update takes over. */
	async relaunch(): Promise<void> {
		try {
			const { relaunch } = await import('@tauri-apps/plugin-process');
			await relaunch();
		} catch (e) {
			this.error = e instanceof Error ? e.message : String(e);
		}
	}
}

export const updater = new UpdaterState();
