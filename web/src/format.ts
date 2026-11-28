export const formatBytes = (n: number) =>
  n < 1024
    ? `${n} B`
    : n < 1024 ** 2
      ? `${(n / 1024).toFixed(0)} KB`
      : `${(n / 1024 ** 2).toFixed(1)} MB`;
export const relativeDate = (date: string) => {
  const diff = Date.now() - Date.parse(date);
  return diff < 60000
    ? '刚刚更新'
    : diff < 3600000
      ? `${Math.floor(diff / 60000)} 分钟前`
      : diff < 86400000
        ? `${Math.floor(diff / 3600000)} 小时前`
        : new Date(date).toLocaleDateString('zh-CN', { month: 'short', day: 'numeric' });
};
