import { Sparkles } from 'lucide-react';
import { Button, Flex, Tooltip, Typography } from 'antd';

const { Text } = Typography;

interface BuildDetectButtonProps {
  loading: boolean;
  onDetect: () => void;
  detectedCommand: string | null;
  onApply: () => void;
}

export function BuildDetectButton({ loading, onDetect, detectedCommand, onApply }: BuildDetectButtonProps) {
  return (
    <Flex vertical gap={6}>
      <Flex align="center" gap={8}>
        <Tooltip title="Use AI to suggest a build command based on the repository structure">
          <Button
            size="small"
            icon={<Sparkles size={14} />}
            onClick={onDetect}
            loading={loading}
          >
            Auto-detect
          </Button>
        </Tooltip>
        {detectedCommand && (
          <Text type="secondary" style={{ fontSize: 12 }} ellipsis>
            Detected: {detectedCommand}
          </Text>
        )}
      </Flex>
      {detectedCommand && (
        <Button size="small" type="link" onClick={onApply} style={{ padding: 0 }}>
          Apply to build command field
        </Button>
      )}
    </Flex>
  );
}
