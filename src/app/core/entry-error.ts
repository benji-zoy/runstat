/** Refus d'une saisie (validation, service injoignable) : un message par champ */
export class EntryError extends Error {
  constructor(readonly errors: string[]) {
    super(errors.join(' ; '));
  }
}
