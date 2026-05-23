import { Alert } from 'antd';

interface ErrorBannerData {
  text: string;
  hint?: string;
}

interface ErrorBannerProps {
  errorBanner: ErrorBannerData | null;
}

export function ErrorBanner({ errorBanner }: ErrorBannerProps) {
  if (!errorBanner?.text) {
    return null;
  }

  return (
    <Alert
      type="error"
      message={errorBanner.text}
      description={errorBanner.hint || undefined}
      showIcon
      closable
      banner
    />
  );
}
