<script lang="ts">
	import Key from "@i18n/i18nKey";
	import { i18n } from "@i18n/translation";
	import Icon from "@iconify/svelte";
	import { onDestroy, onMount } from "svelte";

	import { musicPlayerConfig } from "@/config";

	import CoverImage from "./atoms/CoverImage.svelte";
	import { SKIP_ERROR_DELAY } from "./constants";
	import {
		createAudioPlayerState,
		handleLoadError,
		handleLoadSuccess,
		handleUserInteraction,
		loadSong,
		toggleMute,
		togglePlay,
	} from "./hooks/useAudioPlayer";
	import {
		getAssetPath,
		registerInteractionHandler,
	} from "./hooks/useKeyboardShortcuts";
	import {
		createPlayerUIState,
		hideErrorUI,
		showErrorMessageUI,
		toggleExpandedUI,
		toggleHiddenUI,
		togglePlaylistUI,
	} from "./hooks/usePlayerState";
	import {
		canSkip,
		createPlaylistState,
		fetchMetingPlaylist,
		loadLocalPlaylist,
		nextSong,
		playSong,
		previousSong,
		toggleRepeat,
		toggleShuffle,
	} from "./hooks/usePlaylist";
	import {
		createVolumeDragState,
		handleVolumeKeyDown as handleVolumeKeyDownInternal,
		handleVolumeMove as handleVolumeMoveInternal,
		loadVolumeFromStorage,
		startVolumeDrag as startVolumeDragInternal,
		stopVolumeDrag as stopVolumeDragInternal,
	} from "./hooks/useVolumeControl";
	import MiniPlayer from "./organisms/MiniPlayer.svelte";
	import PlayerBar from "./organisms/PlayerBar.svelte";
	import Playlist from "./organisms/Playlist.svelte";

	const mode = musicPlayerConfig.mode ?? "meting";
	const meting_api =
		musicPlayerConfig.meting_api ??
		"https://www.bilibili.uno/api?server=:server&type=:type&id=:id&auth=:auth&r=:r";
	const meting_id = musicPlayerConfig.id ?? "14164869977";
	const meting_server = musicPlayerConfig.server ?? "netease";
	const meting_type = musicPlayerConfig.type ?? "playlist";

	const audioPlayerState = $state(createAudioPlayerState());
	const playlistState = $state(createPlaylistState());

	const playerUiState = $state(createPlayerUIState());

	let audio: HTMLAudioElement | undefined = $state();
	let volumeBar: HTMLElement | null = null;

	const volumeDragState = $state(createVolumeDragState());

	function showErrorMessage(message: string) {
		showErrorMessageUI(playerUiState, message);
	}

	function hideError() {
		hideErrorUI(playerUiState);
	}

	function toggleExpanded() {
		toggleExpandedUI(playerUiState);
	}

	function toggleHidden() {
		toggleHiddenUI(playerUiState);
	}

	function togglePlaylist() {
		togglePlaylistUI(playerUiState);
	}

	function handleToggleShuffle() {
		toggleShuffle(playlistState);
	}

	function handleToggleRepeat() {
		toggleRepeat(playlistState);
	}

	function handlePreviousSong() {
		const newIndex = previousSong(playlistState);
		if (newIndex !== -1) {
			playSong(playlistState, newIndex);
			loadSong(
				audioPlayerState,
				playlistState.playlist[newIndex],
				audioPlayerState.isPlaying,
			);
		}
	}

	function handleNextSong(autoPlay = true) {
		const newIndex = nextSong(playlistState, audioPlayerState.isPlaying);
		if (newIndex !== -1) {
			playSong(playlistState, newIndex);
			loadSong(
				audioPlayerState,
				playlistState.playlist[newIndex],
				autoPlay,
			);
		}
	}

	function handlePlaySong(index: number) {
		if (playSong(playlistState, index)) {
			loadSong(audioPlayerState, playlistState.playlist[index], true);
		}
	}

	function handleTogglePlay() {
		togglePlay(audioPlayerState, audio);
	}

	function handleToggleMute() {
		toggleMute(audioPlayerState);
	}

	function handleAudioLoadSuccess() {
		handleLoadSuccess(audioPlayerState, audio);
	}

	function handleAudioLoadError(event: Event) {
		const result = handleLoadError(audioPlayerState);
		showErrorMessage(i18n(Key.musicPlayerErrorSong));

		if (result.shouldContinue && playlistState.playlist.length > 1) {
			setTimeout(() => handleNextSong(true), SKIP_ERROR_DELAY);
		} else if (playlistState.playlist.length <= 1) {
			showErrorMessage(i18n(Key.musicPlayerErrorEmpty));
		}
	}

	function handleAudioEnded() {
		if (playlistState.isRepeating === 1) {
			if (audio) {
				audio.currentTime = 0;
				audio.play().catch(() => {});
			}
		} else {
			handleNextSong(true);
		}
	}

	function setProgress(event: MouseEvent) {
		const progressElement = event.currentTarget as HTMLElement | null;
		if (!audio || !progressElement) {return;}
		const rect = progressElement.getBoundingClientRect();
		const percent = (event.clientX - rect.left) / rect.width;
		const newTime = percent * audioPlayerState.duration;
		audio.currentTime = newTime;
		audioPlayerState.currentTime = newTime;
	}

	function handleProgressKeyDown(event: KeyboardEvent) {
		if (event.key === "Enter" || event.key === " ") {
			event.preventDefault();
			const percent = 0.5;
			const newTime = percent * audioPlayerState.duration;
			if (audio) {
				audio.currentTime = newTime;
				audioPlayerState.currentTime = newTime;
			}
		}
	}

	function startVolumeDrag(event: PointerEvent) {
		startVolumeDragInternal(
			event,
			volumeDragState,
			volumeBar,
			audio,
			audioPlayerState,
		);
	}

	function handleVolumeMove(event: PointerEvent) {
		handleVolumeMoveInternal(
			event,
			volumeDragState,
			volumeBar,
			audio,
			audioPlayerState,
		);
	}

	function stopVolumeDrag(event: PointerEvent) {
		stopVolumeDragInternal(
			event,
			volumeDragState,
			volumeBar,
			audioPlayerState,
		);
	}

	function handleVolumeKeyDown(event: KeyboardEvent) {
		handleVolumeKeyDownInternal(event, handleToggleMute);
	}

	let unregister: (() => void) | undefined;

	onMount(() => {
		loadVolumeFromStorage(audioPlayerState);
		const interactionHandler = () =>
			handleUserInteraction(audioPlayerState, audio);
		unregister = registerInteractionHandler(interactionHandler);

		if (!musicPlayerConfig.enable) {
			return;
		}

		if (mode === "meting") {
			fetchMetingPlaylist(
				playlistState,
				meting_api,
				meting_server,
				meting_type,
				meting_id,
				() => {
					audioPlayerState.isLoading = true;
				},
				() => {
					audioPlayerState.isLoading = false;
				},
				showErrorMessage,
			).then(() => {
				if (playlistState.playlist.length > 0) {
					loadSong(
						audioPlayerState,
						playlistState.playlist[0],
						false,
					);
				}
			});
		} else {
			if (loadLocalPlaylist(playlistState, showErrorMessage)) {
				loadSong(audioPlayerState, playlistState.playlist[0], false);
			}
		}
	});

	onDestroy(() => {
		if (unregister) {
			unregister();
		}
	});

	function volumeBarRef(node: HTMLElement) {
		volumeBar = node;
	}
</script>

<audio
	bind:this={audio}
	src={getAssetPath(audioPlayerState.currentSong.url)}
	bind:volume={audioPlayerState.volume}
	bind:muted={audioPlayerState.isMuted}
	onplay={() => (audioPlayerState.isPlaying = true)}
	onpause={() => (audioPlayerState.isPlaying = false)}
	ontimeupdate={() => {
		if (audio) {audioPlayerState.currentTime = audio.currentTime;}
	}}
	onended={handleAudioEnded}
	onerror={handleAudioLoadError}
	onloadeddata={handleAudioLoadSuccess}
	preload="auto"
></audio>

<svelte:window
	on:pointermove={handleVolumeMove}
	on:pointerup={stopVolumeDrag}
/>

{#if musicPlayerConfig.enable}
	{#if playerUiState.showError}
		<div class="fixed bottom-20 right-4 z-[60] max-w-sm">
			<div
				class="bg-red-500 text-white px-4 py-3 rounded-lg shadow-lg flex items-center gap-3 animate-slide-up"
			>
				<Icon
					icon="material-symbols:error"
					class="text-xl flex-shrink-0"
				/>
				<span class="text-sm flex-1">{playerUiState.errorMessage}</span>
				<button
					onclick={hideError}
					class="text-white/80 hover:text-white transition-colors"
				>
					<Icon icon="material-symbols:close" class="text-lg" />
				</button>
			</div>
		</div>
	{/if}

	<div
		class="music-player fixed bottom-4 right-4 z-50 transition-all duration-300 ease-in-out"
		class:expanded={playerUiState.isExpanded}
		class:hidden-mode={playerUiState.isHidden}
	>
		<div
			class="orb-player-container {playerUiState.isHidden
				? 'orb-enter pointer-events-auto'
				: 'orb-leave pointer-events-none'}"
		>
			<CoverImage
				cover={audioPlayerState.currentSong.cover}
				isPlaying={audioPlayerState.isPlaying}
				isLoading={audioPlayerState.isLoading}
				size="orb"
				onclick={toggleHidden}
			/>
		</div>

		<MiniPlayer
			song={audioPlayerState.currentSong}
			currentTime={audioPlayerState.currentTime}
			duration={audioPlayerState.duration}
			isPlaying={audioPlayerState.isPlaying}
			isLoading={audioPlayerState.isLoading}
			isHidden={playerUiState.isExpanded || playerUiState.isHidden}
			onCoverClick={handleTogglePlay}
			onInfoClick={toggleExpanded}
			onHideClick={toggleHidden}
			onExpandClick={toggleExpanded}
		/>

		<PlayerBar
			song={audioPlayerState.currentSong}
			currentTime={audioPlayerState.currentTime}
			duration={audioPlayerState.duration}
			isPlaying={audioPlayerState.isPlaying}
			isLoading={audioPlayerState.isLoading}
			isShuffled={playlistState.isShuffled}
			isRepeating={playlistState.isRepeating}
			showPlaylist={playerUiState.showPlaylist}
			canSkip={canSkip(playlistState)}
			volume={audioPlayerState.volume}
			isMuted={audioPlayerState.isMuted}
			isVolumeDragging={volumeDragState.isVolumeDragging}
			isHidden={!playerUiState.isExpanded}
			{volumeBarRef}
			onPlayClick={handleTogglePlay}
			onPrevClick={handlePreviousSong}
			onNextClick={() => handleNextSong()}
			onShuffleClick={handleToggleShuffle}
			onRepeatClick={handleToggleRepeat}
			onProgressClick={setProgress}
			onProgressKeyDown={handleProgressKeyDown}
			onVolumeButtonClick={handleToggleMute}
			onSliderPointerDown={startVolumeDrag}
			onSliderKeyDown={handleVolumeKeyDown}
			onHideClick={toggleHidden}
			onPlaylistClick={togglePlaylist}
			onCollapseClick={toggleExpanded}
		/>

		<Playlist
			playlist={playlistState.playlist}
			currentIndex={playlistState.currentIndex}
			isPlaying={audioPlayerState.isPlaying}
			show={playerUiState.showPlaylist}
			onClose={togglePlaylist}
			onPlaySong={handlePlaySong}
		/>
	</div>

	<style>
		.orb-player-container {
			position: absolute;
			bottom: 0;
			right: 0;
		}

		.orb-enter {
			animation: orbElasticIn 460ms cubic-bezier(0.22, 1.25, 0.36, 1)
				forwards;
		}

		.orb-leave {
			animation: orbElasticOut 360ms cubic-bezier(0.4, 0, 1, 1) forwards;
		}

		@keyframes orbElasticIn {
			0% {
				opacity: 0;
				transform: translateX(0) scale(0.55);
			}
			70% {
				opacity: 1;
				transform: translateX(0) scale(1.12);
			}
			100% {
				opacity: 1;
				transform: translateX(0) scale(1);
			}
		}

		@keyframes orbElasticOut {
			0% {
				opacity: 1;
				transform: translateX(0) scale(1);
			}
			100% {
				opacity: 0;
				transform: translateX(0) scale(0.6);
			}
		}

		.music-player.hidden-mode {
			width: 3rem;
			height: 3rem;
		}

		.music-player {
			width: 20rem;
			max-width: 20rem;
			min-width: 20rem;
			user-select: none;
		}

		:global(.mini-player) {
			position: absolute;
			bottom: 0;
			right: 0;
		}

		:global(.expanded-player) {
			position: absolute;
			bottom: 0;
			right: 0;
		}

		:global(.orb-player) {
			position: relative;
			backdrop-filter: blur(10px);
			-webkit-backdrop-filter: blur(10px);
		}

		:global(.orb-player::before) {
			content: "";
			position: absolute;
			inset: -0.125rem;
			background: linear-gradient(
				45deg,
				var(--primary),
				transparent,
				var(--primary)
			);
			border-radius: 50%;
			z-index: -1;
			opacity: 0;
			transition: opacity 0.3s ease;
		}

		:global(.orb-player:hover::before) {
			opacity: 0.3;
			animation: rotate 2s linear infinite;
		}

		:global(.orb-player .animate-pulse) {
			animation: musicWave 1.5s ease-in-out infinite;
		}

		@keyframes rotate {
			from {
				transform: rotate(0deg);
			}
			to {
				transform: rotate(360deg);
			}
		}

		@keyframes musicWave {
			0%,
			100% {
				transform: scaleY(0.5);
			}
			50% {
				transform: scaleY(1);
			}
		}

		:global(.animate-pulse) {
			animation: pulse 2s cubic-bezier(0.4, 0, 0.6, 1) infinite;
		}

		@keyframes pulse {
			0%,
			100% {
				opacity: 1;
			}
			50% {
				opacity: 0.5;
			}
		}

		:global(.progress-section div:hover),
		:global(.bottom-controls > div:hover) {
			transform: scaleY(1.2);
			transition: transform 0.2s ease;
		}

		@media (max-width: 768px) {
			.music-player {
				width: 280px !important;
				min-width: 280px !important;
				max-width: 280px !important;
				bottom: 0.5rem !important;
				right: 0.5rem !important;
			}
			:global(.mini-player) {
				width: 280px !important;
			}
			:global(.expanded-player) {
				width: calc(100vw - 16px);
				max-width: none;
			}
			.music-player.expanded {
				width: calc(100vw - 16px);
				min-width: calc(100vw - 16px);
				max-width: none;
				right: 0.5rem !important;
			}
			:global(.playlist-panel) {
				width: calc(100vw - 16px) !important;
				right: 0.5rem !important;
				max-width: none;
			}
			:global(.controls) {
				gap: 8px;
			}
			:global(.controls button) {
				width: 36px;
				height: 36px;
			}
			:global(.controls button:nth-child(3)) {
				width: 44px;
				height: 44px;
			}
		}

		@media (max-width: 480px) {
			.music-player {
				width: 260px;
				min-width: 260px;
				max-width: 260px;
			}
			:global(.song-title) {
				font-size: 14px;
			}
			:global(.song-artist) {
				font-size: 12px;
			}
			:global(.controls) {
				gap: 6px;
				margin-bottom: 12px;
			}
			:global(.controls button) {
				width: 32px;
				height: 32px;
			}
			:global(.controls button:nth-child(3)) {
				width: 40px;
				height: 40px;
			}
			:global(.playlist-item) {
				padding: 8px 12px;
			}
			:global(.playlist-item .w-10) {
				width: 32px;
				height: 32px;
			}
		}

		@keyframes slide-up {
			from {
				transform: translateY(100%);
				opacity: 0;
			}
			to {
				transform: translateY(0);
				opacity: 1;
			}
		}

		.animate-slide-up {
			animation: slide-up 0.3s ease-out;
		}

		@media (hover: none) and (pointer: coarse) {
			:global(.music-player button),
			:global(.playlist-item) {
				min-height: 44px;
			}
			:global(.progress-section > div),
			:global(.bottom-controls > div:nth-child(2)) {
				height: 12px;
			}
		}

		@keyframes spin-continuous {
			from {
				transform: rotate(0deg);
			}
			to {
				transform: rotate(360deg);
			}
		}

		:global(.cover-container img) {
			animation: spin-continuous 3s linear infinite;
			animation-play-state: paused;
		}

		:global(.cover-container img.spinning) {
			animation-play-state: running;
		}

		:global(button.bg-\\[var\\(--primary\\)\\]) {
			box-shadow: 0 0 0 2px var(--primary);
			border: none;
		}
	</style>
{/if}
