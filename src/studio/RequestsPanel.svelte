<script lang="ts">
	import { Bot, MessageSquare, Trash2, X } from '@lucide/svelte';
	import type { AiDjAction, ListenerMessage } from '../lib/types';

	export let listenerMessages: ListenerMessage[];
	export let aiDjActions: AiDjAction[];
	export let aiDjModelLabel: string;
	export let onDismissRequest: (id: string) => void;
	export let onClearRequests: () => void;
	export let onClearAiDjActions: () => void;

	function formatRequestTime(value: string): string {
		const date = new Date(value);
		if (Number.isNaN(date.getTime())) {
			return '';
		}
		return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
	}

	function aiDjStatusLabel(action: AiDjAction): string {
		switch (action.status) {
			case 'analyzing':
				return 'Analyzing';
			case 'queued_next':
				return 'Queued next';
			case 'queued':
				return action.queuePosition ? `Queued #${action.queuePosition}` : 'Queued';
			case 'already_playing':
				return 'Already playing';
			case 'played_now':
				return 'Played now';
			case 'ignored_not_song':
				return 'Not a song';
			case 'ignored_unavailable':
				return 'Unavailable';
			case 'ignored_ambiguous':
				return 'Ambiguous';
			case 'ignored_unsafe':
				return 'Unsafe ignored';
			case 'log_only_mode':
				return 'Log only';
			case 'disabled':
				return 'Disabled';
			case 'failed':
				return 'Failed';
		}
	}

	function aiDjStatusClass(action: AiDjAction): string {
		if (
			action.status === 'queued_next' ||
			action.status === 'queued' ||
			action.status === 'already_playing' ||
			action.status === 'played_now'
		) {
			return 'played';
		}
		if (action.status === 'analyzing') {
			return 'pending';
		}
		if (action.status === 'failed' || action.status === 'ignored_unsafe') {
			return 'warning';
		}
		return 'ignored';
	}
</script>

<div class="requests-panel panel">
	<div class="panel-head">
		<div>
			<span class="eyebrow">listener requests</span>
			<h2>Request line</h2>
		</div>
		<button
			class="icon-button"
			type="button"
			disabled={listenerMessages.length === 0}
			aria-label="Clear listener requests"
			on:click={onClearRequests}
		>
			<Trash2 />
		</button>
	</div>

	<div class="request-panel-body">
		<section class="request-section" aria-label="Listener request inbox">
			<div class="request-section-head">
				<span class="eyebrow">inbox</span>
				<span>{listenerMessages.length}</span>
			</div>
			<div class="request-inbox">
				{#each listenerMessages as request (request.id)}
					<article class="request-card">
						<div>
							<MessageSquare />
							<strong>{request.name}</strong>
							<time datetime={request.receivedAt}>{formatRequestTime(request.receivedAt)}</time>
						</div>
						<button class="icon-button" type="button" aria-label={`Dismiss request from ${request.name}`} on:click={() => onDismissRequest(request.id)}>
							<X />
						</button>
						<p>{request.message}</p>
					</article>
				{/each}
				{#if listenerMessages.length === 0}
					<p class="empty-note">No listener requests yet.</p>
				{/if}
			</div>
		</section>

		<section class="request-section" aria-label="AI DJ actions">
			<div class="request-section-head">
				<div>
					<span class="eyebrow">AI DJ actions</span>
					<span>{aiDjModelLabel}</span>
				</div>
				<button
					class="icon-button"
					type="button"
					disabled={aiDjActions.length === 0}
					aria-label="Clear AI DJ actions"
					on:click={onClearAiDjActions}
				>
					<Trash2 />
				</button>
			</div>
			<div class="ai-action-list">
				{#each aiDjActions as action (action.id)}
					<article class="ai-action-card">
						<div class="ai-action-meta">
							<Bot />
							<span class={`ai-status ${aiDjStatusClass(action)}`}>{aiDjStatusLabel(action)}</span>
							<time datetime={action.updatedAt}>{formatRequestTime(action.updatedAt)}</time>
						</div>
						<p class="ai-request"><strong>{action.listenerName}</strong>: {action.requestMessage}</p>
						{#if action.matchedTrackTitle}
							<p class="ai-track">{action.matchedTrackTitle} - {action.matchedTrackArtist}</p>
						{/if}
						<p>{action.reason}</p>
					</article>
				{/each}
				{#if aiDjActions.length === 0}
					<p class="empty-note">No AI DJ actions yet.</p>
				{/if}
			</div>
		</section>
	</div>
</div>

<style>
	.requests-panel {
		display: grid;
		min-height: 0;
		grid-template-rows: auto minmax(0, 1fr);
		gap: 8px;
		overflow: hidden;
		padding: 10px;
	}

	.panel-head {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 12px;
	}

	.requests-panel .panel-head h2 {
		margin: 4px 0 0;
		font-family: var(--serif);
		font-size: 20px;
		font-style: italic;
		font-weight: 400;
	}

	.request-panel-body,
	.request-section,
	.request-inbox,
	.ai-action-list {
		display: grid;
		min-height: 0;
	}

	.request-panel-body {
		grid-template-columns: repeat(2, minmax(0, 1fr));
		gap: 10px;
	}

	.request-section {
		grid-template-rows: auto minmax(0, 1fr);
		gap: 6px;
		overflow: hidden;
	}

	.request-section-head {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 8px;
		color: var(--ink-faint);
		font-size: 10px;
		font-weight: 700;
		text-transform: uppercase;
	}

	.request-section-head > div {
		display: flex;
		min-width: 0;
		align-items: center;
		gap: 8px;
	}

	.request-section-head span:not(.eyebrow) {
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.request-inbox,
	.ai-action-list {
		align-content: start;
		gap: 8px;
		overflow: auto;
		padding-right: 2px;
	}

	.request-card,
	.ai-action-card {
		display: grid;
		gap: 7px 10px;
		padding: 9px;
		border: 1px solid var(--line);
		border-radius: 4px;
		background: rgba(255, 255, 255, 0.32);
	}

	.request-card {
		grid-template-columns: minmax(0, 1fr) auto;
	}

	.request-card > div {
		display: flex;
		min-width: 0;
		align-items: center;
		gap: 7px;
	}

	.request-card strong {
		min-width: 0;
		overflow: hidden;
		font-size: 12px;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.request-card time {
		flex: 0 0 auto;
		color: var(--ink-faint);
		font-size: 10px;
	}

	.request-card p {
		grid-column: 1 / -1;
		margin: 0;
		color: var(--ink);
		font-size: 12px;
		line-height: 1.35;
		overflow-wrap: anywhere;
	}

	.request-card :global(svg) {
		width: 14px;
		height: 14px;
		flex: 0 0 auto;
	}

	.request-card .icon-button {
		width: 30px;
		min-height: 30px;
	}

	.ai-action-card {
		grid-template-columns: minmax(0, 1fr);
	}

	.ai-action-meta {
		display: flex;
		min-width: 0;
		align-items: center;
		gap: 7px;
	}

	.ai-action-meta :global(svg) {
		width: 14px;
		height: 14px;
		flex: 0 0 auto;
	}

	.ai-action-meta time {
		margin-left: auto;
		color: var(--ink-faint);
		font-size: 10px;
	}

	.ai-status {
		display: inline-flex;
		min-width: 0;
		align-items: center;
		min-height: 20px;
		padding: 0 7px;
		border-radius: 999px;
		background: rgba(20, 19, 17, 0.08);
		color: var(--ink-dim);
		font-size: 9px;
		font-weight: 800;
		text-transform: uppercase;
	}

	.ai-status.played {
		background: rgba(31, 118, 108, 0.14);
		color: #1f766c;
	}

	.ai-status.pending {
		background: rgba(213, 166, 66, 0.2);
		color: #775a15;
	}

	.ai-status.warning {
		background: rgba(181, 31, 36, 0.12);
		color: var(--signal);
	}

	.ai-action-card p {
		margin: 0;
		color: var(--ink);
		font-size: 11px;
		line-height: 1.35;
		overflow-wrap: anywhere;
	}

	.ai-action-card .ai-request {
		color: var(--ink-dim);
	}

	.ai-action-card .ai-track {
		color: #1f766c;
		font-weight: 700;
	}

	.empty-note {
		color: var(--ink-dim);
		font-size: 11px;
	}

	@media (max-width: 980px) {
		.request-panel-body {
			grid-template-columns: 1fr;
		}
	}
</style>
