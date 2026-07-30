export function createSingleFlightInitializer<T>(initialize: () => Promise<T>): () => Promise<T> {
  let instance: T | undefined;
  let pending: Promise<T> | undefined;

  return async () => {
    if (instance !== undefined) {
      return instance;
    }

    if (!pending) {
      pending = initialize()
        .then((created) => {
          instance = created;
          return created;
        })
        .catch((error) => {
          // 初始化失败后允许下一次请求重试，避免函数实例永久不可用。
          pending = undefined;
          throw error;
        });
    }

    return pending;
  };
}
