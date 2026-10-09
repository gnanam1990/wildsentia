import { accountState, checkSiweMessage, errorText, type AccountView } from './accountModel.js';

interface EthereumProvider { request(args: { method: string; params?: unknown[] }): Promise<unknown> }
declare global { interface Window { ethereum?: EthereumProvider } }

/** Calls the server under /api with the session cookie. Errors carry the server's error code. */
export async function api<T>(path: string, init: { method?: 'GET' | 'POST'; body?: unknown } = {}): Promise<T> {
  const res = await fetch(`/api${path}`, { method: init.method ?? 'GET', credentials: 'same-origin', cache: 'no-store',
    ...(init.method === 'POST' ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify(init.body ?? {}) } : {}) });
  let body: unknown = null;
  try { body = await res.json(); } catch { body = null; }
  if (!res.ok) throw new Error(body && typeof body === 'object' && 'error' in body ? String((body as { error: unknown }).error) : `http_${res.status}`);
  return body as T;
}

export async function loadAccount(): Promise<AccountView | null> {
  try { return (await api<{ account: AccountView }>('/accounts/me')).account; } catch { return null; }
}

export function wallet(): EthereumProvider {
  if (!window.ethereum) throw new Error('no_wallet');
  return window.ethereum;
}

/** Hex of a UTF-8 text, for personal_sign. */
const hexOf = (text: string) => `0x${Array.from(new TextEncoder().encode(text), (b) => b.toString(16).padStart(2, '0')).join('')}`;

/** Links the browser wallet: the server's sign-in message, checked to be for this site and this wallet, then signed. */
export async function linkWallet(): Promise<string> {
  const eth = wallet();
  const accounts = await eth.request({ method: 'eth_requestAccounts' });
  const address = Array.isArray(accounts) && typeof accounts[0] === 'string' ? accounts[0] : '';
  if (!/^0x[0-9a-fA-F]{40}$/.test(address)) throw new Error('no_wallet');
  const challenge = await api<{ nonce: string; message: string; chainId: number }>('/accounts/wallet/challenge', { method: 'POST', body: { address } });
  if (!checkSiweMessage(challenge.message, location.host, address)) throw new Error('wrong_site');
  const signature = await eth.request({ method: 'personal_sign', params: [hexOf(challenge.message), address] });
  return (await api<{ wallet: string }>('/accounts/wallet/verify', { method: 'POST', body: { address, nonce: challenge.nonce, signature } })).wallet;
}

/** The account box at the top of each page: who is signed in, and sign in, link wallet and sign out. */
export async function mountAccountBox(onChange: (a: AccountView | null) => void): Promise<AccountView | null> {
  const status = document.querySelector<HTMLElement>('#account-status')!;
  const signin = document.querySelector<HTMLAnchorElement>('#account-signin')!;
  const link = document.querySelector<HTMLButtonElement>('#account-wallet')!;
  const signout = document.querySelector<HTMLButtonElement>('#account-signout')!;
  const render = (a: AccountView | null) => {
    const state = accountState(a);
    status.textContent = state.text;
    signin.hidden = state.kind !== 'signed_out';
    link.hidden = state.kind === 'signed_out' || state.kind === 'too_new';
    link.textContent = a?.wallet ? 'Link another wallet' : 'Link a wallet';
    signout.hidden = state.kind === 'signed_out';
    onChange(a);
  };
  link.addEventListener('click', async () => {
    link.disabled = true;
    status.textContent = 'Check your wallet: sign the message to link it. It is not a transaction.';
    try { await linkWallet(); render(await loadAccount()); }
    catch (e) { status.textContent = errorText((e as Error).message); }
    finally { link.disabled = false; }
  });
  signout.addEventListener('click', async () => {
    try { await api('/accounts/logout', { method: 'POST' }); } catch { /* signed out either way */ }
    render(null);
  });
  const a = await loadAccount();
  render(a);
  return a;
}
