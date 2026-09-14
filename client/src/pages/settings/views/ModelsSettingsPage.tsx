import SettingsPage from "../SettingsPage";
import { SettingsShell } from "../components/SettingsShell";

export default function ModelsSettingsPage() {
  return (
    <SettingsShell title="模型与厂商" description="分别配置文字创作用的文本模型和图片生成用的生图模型。">
      <SettingsPage />
    </SettingsShell>
  );
}
