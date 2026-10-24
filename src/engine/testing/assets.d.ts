// Fixtures importées par les tests du moteur (option `loader` d'angular.json : octets ou texte)
declare module '*.fit' {
  const bytes: Uint8Array;
  export default bytes;
}
declare module '*.gz' {
  const bytes: Uint8Array;
  export default bytes;
}
declare module '*.txt' {
  const text: string;
  export default text;
}
declare module '*.jsonl' {
  const text: string;
  export default text;
}
declare module '*.csv' {
  const text: string;
  export default text;
}
declare module '*.tcx' {
  const text: string;
  export default text;
}
