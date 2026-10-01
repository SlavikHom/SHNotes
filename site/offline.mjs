const base = new URL('./', import.meta.url);
let registration;
export async function offlineReady() {
  if (!('serviceWorker' in navigator) || !globalThis.isSecureContext) throw Error('Для чтения без интернета нужен HTTPS или локальный просмотр.');
  registration ||= navigator.serviceWorker.register(new URL('sw.js', base), {scope: base.pathname});
  try {await registration} catch {registration = null; throw Error('Браузер не разрешил сохранение для чтения без интернета.')}
  let timer;
  const ready = await Promise.race([navigator.serviceWorker.ready, new Promise((_, reject) => {
    timer = setTimeout(() => reject(Error('Сохранение пока недоступно. Попробуйте ещё раз.')), 8000);
  })]).finally(() => clearTimeout(timer));
  if (!ready.active) throw Error('Сохранение пока недоступно. Попробуйте ещё раз.');
  return ready.active;
}

export async function offlineCommand(type, payload = {}, onProgress = () => {}) {
  const worker = await offlineReady();
  return new Promise((resolve, reject) => {
    const channel = new MessageChannel();
    // A failed worker/network must not leave the controls busy indefinitely.
    let timer;
    const resetTimeout = () => {clearTimeout(timer); timer = setTimeout(() => {
      channel.port1.close(); reject(Error('Сохранение заняло слишком много времени. Проверьте соединение и повторите.'));
    }, 120000)};
    resetTimeout();
    channel.port1.onmessage = ({data}) => {
      if (data.progress) {resetTimeout(); onProgress(data.progress); return}
      clearTimeout(timer); channel.port1.close();
      data.error ? reject(Error(data.error)) : resolve(data.result);
    };
    worker.postMessage({type, ...payload}, [channel.port2]);
  });
}
