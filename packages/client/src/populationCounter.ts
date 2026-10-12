import 'number-flow';

/** Keep the custom element mounted so authoritative population updates can animate. */
export function populationCounter(host: HTMLElement): (total: number | null, listHtml: string) => void {
  const details = document.createElement('details');
  const summary = document.createElement('summary');
  const count = document.createElement('number-flow');
  const list = document.createElement('div');
  const unknown = document.createElement('span');
  count.locales = 'en-US';
  count.format = { maximumFractionDigits: 0 };
  count.respectMotionPreference = true;
  count.transformTiming = { duration: 450, easing: 'ease-out' };
  count.opacityTiming = { duration: 180, easing: 'ease-out' };
  list.className = 'pop-list';
  unknown.textContent = 'Population unavailable';
  unknown.className = 'population-unknown';
  summary.append(count, document.createTextNode(' animals'));
  details.append(summary, list);
  host.replaceChildren(details, unknown);
  details.hidden = true;
  const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
  count.animated = !reducedMotion.matches;
  reducedMotion.addEventListener('change', () => { count.animated = !reducedMotion.matches; });
  let previous: number | null = null;
  let previousList = '';
  return (total, listHtml) => {
    details.hidden = total === null;
    unknown.hidden = total !== null;
    if (total === null) { details.open = false; previous = null; return; }
    if (previous !== total) {
      // Recovery from an unavailable observation should not imply a population change.
      count.animated = previous !== null && !reducedMotion.matches;
      count.update(total);
      previous = total;
    }
    if (previousList !== listHtml) { list.innerHTML = listHtml; previousList = listHtml; }
  };
}
