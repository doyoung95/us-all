export const process = (sec: number) =>
  new Promise<void>((resolve) =>
    setTimeout(() => {
      resolve();
    }, sec * 1000),
  );
