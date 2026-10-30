<script lang="ts">
import IconButton from "@components/atoms/action/IconButton.svelte";
import SearchPanel from "@components/atoms/blog/SearchPanel.svelte";
import SearchBar from "@components/molecules/SearchBar.svelte";
import I18nKey from "@i18n/i18nKey";
import { i18n } from "@i18n/translation";

let keywordDesktop = "";
let keywordMobile = "";
let results: Array<{url: string; title: string; excerpt: string}> = [];
let currentRequest = 0;
let timer: ReturnType<typeof setTimeout>;

function escapeHtml(value: string) {
  return value.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] || c);
}
function panel(show: boolean) {
  document.getElementById("search-panel")?.classList.toggle("float-panel-closed", !show);
}
function schedule(query: string, desktop: boolean) {
  clearTimeout(timer);
  const request = ++currentRequest;
  if (!query.trim()) { results = []; if (desktop) panel(false); return; }
  timer = setTimeout(async () => {
    try {
      const response = await fetch(`/api/search?q=${encodeURIComponent(query)}`);
      if (!response.ok) throw new Error("search unavailable");
      const data = await response.json();
      if (request !== currentRequest) return;
      results = data.hits.map((hit: {url: string; title: string; description: string}) => ({
        url: hit.url, title: hit.title, excerpt: escapeHtml(hit.description),
      }));
      if (desktop) panel(results.length > 0);
    } catch {
      if (request === currentRequest) { results = []; if (desktop) panel(false); }
    }
  }, 200);
}
$: if (typeof window !== "undefined" && keywordDesktop !== undefined) schedule(keywordDesktop, true);
$: if (typeof window !== "undefined" && keywordMobile !== undefined && keywordMobile) schedule(keywordMobile, false);
</script>

<SearchBar bind:value={keywordDesktop} id="search-input-desktop" name="search-desktop" placeholder={i18n(I18nKey.search)} onfocus={() => schedule(keywordDesktop, true)} oncollapse={() => panel(false)} />
<IconButton icon="material-symbols:search" label="Search Panel" id="search-switch" size="small" shape="round" onclick={() => document.getElementById("search-panel")?.classList.toggle("float-panel-closed")} class="lg:!hidden !w-10 !h-10 !text-[1.25rem]" />
<SearchPanel id="search-panel" class="float-panel float-panel-closed absolute md:w-[30rem] top-20 left-4 md:left-[unset] right-4" bind:query={keywordMobile} {results} placeholder={i18n(I18nKey.search)} hideInputOnDesktop />
