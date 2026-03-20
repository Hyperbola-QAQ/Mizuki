<script lang="ts">
	import Icon from "@iconify/svelte";
	import { slide } from "svelte/transition";

	import Key from "../../../../i18n/i18nKey";
	import { i18n } from "../../../../i18n/translation";
	import PlaylistItem from "../atoms/PlaylistItem.svelte";
	import type { Song } from "../types";

	interface Props {
		playlist: Song[];
		currentIndex: number;
		isPlaying: boolean;
		show: boolean;
		onClose: () => void;
		onPlaySong: (index: number) => void;
	}

	const {
		playlist,
		currentIndex,
		isPlaying,
		show,
		onClose,
		onPlaySong,
	}: Props = $props();
</script>

{#if show}
	<div
		class="playlist-panel float-panel fixed bottom-20 right-4 w-80 max-h-96 overflow-hidden z-50"
		transition:slide={{ duration: 300, axis: "y" }}
	>
		<div
			class="playlist-header flex items-center justify-between p-4 border-b border-[var(--line-divider)]"
		>
			<h3 class="text-lg font-semibold text-90">
				{i18n(Key.musicPlayerPlaylist)}
			</h3>
			<button class="btn-plain w-8 h-8 rounded-lg" onclick={onClose}>
				<Icon icon="material-symbols:close" class="text-lg" />
			</button>
		</div>
		<div class="playlist-content overflow-y-auto max-h-80 hide-scrollbar">
			{#each playlist as song, index}
				<PlaylistItem
					{song}
					{index}
					isCurrent={index === currentIndex}
					{isPlaying}
					onclick={() => onPlaySong(index)}
				/>
			{/each}
		</div>
	</div>
{/if}
