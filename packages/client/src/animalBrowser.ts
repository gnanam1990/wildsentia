import { animalDetail, animalTitle, speciesGroups } from './animalBrowserModel.js';

interface Row { id: string; speciesId: string; sex: string; stage: string; state: string; ageDays: number }
const PAGE = 50;

/**
 * Every living animal, to choose one to watch: by species, a page at a time, with a search by its
 * number. Reads the server's small list (`/animals/list`), so a viewer can reach any of a world's
 * animals, not only those in the regions around the camera. Choosing one follows it.
 */
export function createAnimalBrowser(watch: (id: string) => void, population: () => Readonly<Record<string, number>> | undefined):
  (speciesId?: string) => void {
  const dialog = document.createElement('dialog'); dialog.className = 'forest-dialog animal-browser';
  dialog.setAttribute('aria-labelledby', 'animal-browser-title');
  const header = document.createElement('div'); header.className = 'dialog-header';
  const title = document.createElement('h2'); title.id = 'animal-browser-title'; title.textContent = 'Animals';
  const close = document.createElement('button'); close.type = 'button'; close.className = 'text-button'; close.textContent = 'Close';
  close.onclick = () => dialog.close();
  header.append(title, close);
  const filters = document.createElement('div'); filters.className = 'animal-browser-filters';
  const species = document.createElement('select'); species.setAttribute('aria-label', 'Species');
  const search = document.createElement('input'); search.type = 'search'; search.placeholder = 'Search by number, e.g. 91f8';
  search.setAttribute('aria-label', 'Search by number'); search.maxLength = 32;
  filters.append(species, search);
  const status = document.createElement('p'); status.className = 'dialog-status'; status.setAttribute('role', 'status');
  const list = document.createElement('ul'); list.className = 'animal-browser-list';
  const more = document.createElement('button'); more.type = 'button'; more.textContent = 'Show more'; more.hidden = true;
  dialog.append(header, filters, status, list, more);

  let shown = 0, total = 0, request: AbortController | null = null, typing = 0;
  const fillSpecies = () => {
    const chosen = species.value;
    const all = document.createElement('option'); all.value = ''; all.textContent = 'Every animal';
    species.replaceChildren(all, ...speciesGroups(population()).map((g) => {
      const group = document.createElement('optgroup'); group.label = g.label;
      group.append(...g.species.map((s) => {
        const option = document.createElement('option'); option.value = s.id; option.textContent = `${s.name} (${s.count.toLocaleString('en-US')})`;
        return option;
      }));
      return group;
    }));
    species.value = chosen;
  };
  const load = async (append: boolean) => {
    request?.abort(); request = new AbortController();
    if (!append) { shown = 0; list.replaceChildren(); }
    status.textContent = 'Loading…'; more.hidden = true;
    const query = new URLSearchParams({ limit: String(PAGE), offset: String(shown) });
    if (species.value) query.set('species', species.value);
    if (search.value.trim()) query.set('q', search.value.trim());
    try {
      const response = await fetch(`/api/animals/list?${query}`, { signal: request.signal });
      if (!response.ok) throw new Error(String(response.status));
      const page = await response.json() as { total: number; animals: Row[] };
      total = page.total;
      list.append(...page.animals.map((row) => {
        const item = document.createElement('li');
        const choose = document.createElement('button'); choose.type = 'button'; choose.className = 'animal-browser-row';
        const name = document.createElement('strong'); name.textContent = animalTitle(row.id);
        const detail = document.createElement('span'); detail.textContent = animalDetail(row);
        choose.append(name, detail);
        choose.onclick = () => { dialog.close(); watch(row.id); };
        item.append(choose);
        return item;
      }));
      shown += page.animals.length;
      status.textContent = total === 0 ? 'No living animal matches.' : `${total.toLocaleString('en-US')} living · showing ${shown.toLocaleString('en-US')}`;
      more.hidden = shown >= total;
    } catch (error) {
      if ((error as Error).name === 'AbortError') return;
      status.textContent = 'The list could not be loaded. Try again in a moment.';
    }
  };
  species.onchange = () => { void load(false); };
  search.oninput = () => { clearTimeout(typing); typing = window.setTimeout(() => { void load(false); }, 250); };
  more.onclick = () => { void load(true); };

  return (speciesId = '') => {
    if (!dialog.isConnected) (document.querySelector('.observer-app') ?? document.body).append(dialog);
    fillSpecies();
    species.value = speciesId;
    search.value = '';
    if (!dialog.open) dialog.showModal();
    void load(false);
  };
}
