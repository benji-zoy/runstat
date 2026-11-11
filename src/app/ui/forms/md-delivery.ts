import { AiDoc } from '../../core/ai/exports';

/**
 * Remise d'un export Markdown à la personne (« Discuter avec une IA », « Préparer mon plan ») : copier, télécharger ou
 * partager ; rien n'est envoyé par RunStat. Chaque fonction renvoie le message à afficher (null : rien à dire).
 */
export const canCopy = () => Boolean(navigator.clipboard) && isSecureContext;
export const canShare = () => typeof navigator.share === 'function';

export async function copyDoc(d: AiDoc): Promise<string> {
  try {
    await navigator.clipboard.writeText(d.markdown);
    return 'Copié : colle-le dans une nouvelle conversation avec l\'IA.';
  } catch {
    return 'Copie impossible : utilise « Télécharger ».';
  }
}

export function downloadDoc(d: AiDoc): string {
  const url = URL.createObjectURL(new Blob([d.markdown], { type: 'text/markdown;charset=utf-8' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = d.filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  return `Fichier ${d.filename} téléchargé : joins-le à ta conversation avec l'IA.`;
}

/**
 * Feuille de partage du téléphone, en un seul appel (un refus consomme le geste de l'utilisateur) : le texte en fichier
 * .txt, sinon le texte brut. Pas de .md : Chrome sur Android l'annonce partageable (`canShare`) puis le refuse
 * (« NotAllowedError: Permission denied »), seules certaines extensions passent, dont .txt.
 */
export async function shareDoc(d: AiDoc): Promise<string | null> {
  const txt = new File([d.markdown], d.filename.replace(/\.md$/, '.txt'), { type: 'text/plain' });
  let files = false;
  try {
    files = navigator.canShare?.({ files: [txt] }) ?? false;
  } catch {
    files = false;
  }
  const data: ShareData = files ? { files: [txt] } : { text: d.markdown };
  try {
    await navigator.share(data);
    return data.files ? `Fichier ${data.files[0].name} partagé.` : 'Texte partagé.';
  } catch (e) {
    const err = e as Error;
    if (err?.name === 'AbortError') return null;
    return `Partage refusé par le téléphone (${err?.name ?? 'erreur'}${err?.message ? ` : ${err.message}` : ''}) : utilise « Copier » ou « Télécharger ».`;
  }
}
