import { requestUrl } from 'obsidian';

/**
 * リモートのベースフォルダ（Vault 名）とパスを変換するユーティリティ。
 *
 * SyncEngine は常に Vault 相対パス（例: `Notes/a.md`）で動作し、
 * WebDAV クライアント層がここのヘルパで「ベースフォルダ配下」へ透過的に
 * 変換・逆変換する。これによりローカル（Vault 全体）とリモート
 * （`/<Vault名>/...`）の非対称マッピングをクライアント内部に閉じ込める。
 */

/** 先頭・末尾のスラッシュを除去し、リモートフォルダ名として正規化する。 */
export function normalizeBase(name: string): string {
  return (name ?? '').replace(/^\/+|\/+$/g, '');
}

/** ベースフォルダと Vault 相対パスを連結して、files ルート相対のリモートパスを得る。 */
export function toRemotePath(base: string, rel: string): string {
  const r = (rel ?? '').replace(/^\/+/, '');
  if (!base) return r;
  return r ? `${base}/${r}` : base;
}

/**
 * files ルート相対のリモートパスからベースフォルダを除去し、Vault 相対パスを得る。
 * ベースフォルダ配下でない場合は null を返す（同期対象外として無視するため）。
 */
export function fromRemotePath(base: string, full: string): string | null {
  const f = (full ?? '').replace(/^\/+/, '');
  if (!base) return f;
  if (f === base) return ''; // ベースフォルダ自身
  const prefix = `${base}/`;
  return f.startsWith(prefix) ? f.slice(prefix.length) : null;
}

/** files ルート相対パスを WebDAV URL に組み立てる（スラッシュは保持しつつ各セグメントを URL エンコード）。 */
export function encodeRemoteUrl(baseUrl: string, remotePath: string): string {
  if (!remotePath) return baseUrl;
  return `${baseUrl}/${encodeURIComponent(remotePath).replace(/%2F/g, '/')}`;
}

/**
 * リモートファイルパスの親コレクション（ディレクトリ）を MKCOL で冪等に作成する。
 * 既存（405）は無視し、作成済みは createdCache で重複リクエストを抑止する。
 * WebDAV の PUT は親ディレクトリを自動生成しないため、アップロード前に必須。
 */
export async function ensureRemoteDir(
  ctx: { baseUrl: string; authHeader: string },
  remoteFilePath: string,
  createdCache: Set<string>,
): Promise<void> {
  const segments = remoteFilePath.split('/').slice(0, -1); // 末尾のファイル名を除外
  let acc = '';
  for (const seg of segments) {
    if (!seg) continue;
    acc = acc ? `${acc}/${seg}` : seg;
    if (createdCache.has(acc)) continue;
    await requestUrl({
      url: encodeRemoteUrl(ctx.baseUrl, acc),
      method: 'MKCOL',
      headers: { Authorization: ctx.authHeader },
      throw: false,
    });
    // 201=作成 / 405=既存 のいずれもOK。その他のコードもベストエフォートで続行。
    createdCache.add(acc);
  }
}
