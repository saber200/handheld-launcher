using Windows.UI.Xaml.Controls;

namespace FantasyHub.GameBar
{
    public sealed partial class LaunchPage : Page
    {
        private readonly Strings text = new Strings();
        private bool initialized;

        public LaunchPage()
        {
            InitializeComponent();
            LanguageBox.SelectedIndex = text.English ? 1 : 0;
            GuideText.Text = text.LaunchHelp;
            initialized = true;
        }

        private void LanguageChanged(object sender, SelectionChangedEventArgs e)
        {
            if (!initialized) return;
            // 普通启动仅改变本地说明语言，不启动 full-trust 中转。
            text.SetLocale(LanguageBox.SelectedIndex == 1 ? "en-US" : "zh-CN");
            GuideText.Text = text.LaunchHelp;
        }
    }
}