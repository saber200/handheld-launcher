using System;
using System.Collections.Generic;
using Windows.Data.Json;

namespace FantasyHub.GameBar
{
    internal static class Models
    {
        internal static string Text(JsonObject obj, string key, string fallback = "") =>
            obj != null && obj.ContainsKey(key) && obj[key].ValueType == JsonValueType.String ? obj[key].GetString() : fallback;
        internal static bool Bool(JsonObject obj, string key) =>
            obj != null && obj.ContainsKey(key) && obj[key].ValueType == JsonValueType.Boolean && obj[key].GetBoolean();
        internal static JsonObject Object(JsonObject obj, string key) =>
            obj != null && obj.ContainsKey(key) && obj[key].ValueType == JsonValueType.Object ? obj[key].GetObject() : null;
        internal static int? Number(JsonObject obj, string key)
        {
            if (obj == null || !obj.ContainsKey(key) || obj[key].ValueType != JsonValueType.Number) return null;
            double value = obj[key].GetNumber();
            return double.IsNaN(value) || double.IsInfinity(value) || value < int.MinValue || value > int.MaxValue ? (int?)null : (int)Math.Round(value);
        }
        internal static int? Integer(JsonObject obj, string key)
        {
            int? number = Number(obj, key);
            return number.HasValue && obj[key].GetNumber() == number.Value ? number : null;
        }
        internal static TdpInfo Tdp(JsonObject obj)
        {
            if (obj == null) return null;
            int? minimum = Integer(obj, "minW"), maximum = Integer(obj, "maxW");
            if (!minimum.HasValue || !maximum.HasValue)
                throw new InvalidOperationException("Missing device TDP range.");
            int min = minimum.Value, max = maximum.Value;
            if (min < 1 || max > 1000 || max < min) throw new InvalidOperationException("Invalid device TDP range.");
            int? current = Integer(obj, "watts");
            if ((obj.ContainsKey("watts") && obj["watts"].ValueType != JsonValueType.Null && !current.HasValue)
                || (current.HasValue && (current < min || current > max)))
                throw new InvalidOperationException("Invalid current TDP.");
            var presets = new List<int>();
            if (obj.ContainsKey("presets") && obj["presets"].ValueType == JsonValueType.Array)
                foreach (var value in obj["presets"].GetArray())
                    if (value.ValueType == JsonValueType.Number)
                    {
                        double number = value.GetNumber();
                        if (number >= min && number <= max && number == Math.Truncate(number))
                        {
                            int watts = (int)Math.Round(number);
                            if (!presets.Contains(watts)) presets.Add(watts);
                        }
                    }
            if (presets.Count == 0)
                foreach (int value in new[] { 5, 10, 15, 25, 35, 40 })
                    if (value >= min && value <= max) presets.Add(value);
            if (presets.Count == 0) presets.Add(min);
            return new TdpInfo
            {
                Min = min, Max = max, Watts = current, Presets = presets,
                Supported = Bool(obj, "supported"), Cpu = Text(obj, "cpuName"),
                Vendor = Text(obj, "vendor"), Backend = Text(obj, "backend"), Message = Text(obj, "message")
            };
        }
    }

    internal sealed class TdpInfo
    {
        internal int Min, Max;
        internal int? Watts;
        internal List<int> Presets;
        internal bool Supported;
        internal string Cpu, Vendor, Backend, Message;
    }
    /// 预设按钮的显示项。
    /// 原前端（global.css 的 .tdp-preset）是「文字 + 选中态整块变 accent 色」，
    /// 这边交给 XAML 的 ToggleButton 承载：IsChecked 只单向反映这里的 On。
    /// 注意 On 的 setter 无条件发通知 —— 用户连点同一个预设时数值没变，
    /// 若只在值变化时通知，按钮会停在 ToggleButton 自己切出来的错误状态上。
    public sealed class PresetOption : System.ComponentModel.INotifyPropertyChanged
    {
        private bool on;
        private int watts;
        internal PresetOption(int watts) { this.watts = watts; }
        internal int Watts
        {
            get { return watts; }
            set
            {
                watts = value;
                Notify("Watts");
                Notify("Label");
            }
        }
        public string Label { get { return watts + "W"; } }
        public bool On
        {
            get { return on; }
            set
            {
                on = value;
                Notify("On");
            }
        }
        public event System.ComponentModel.PropertyChangedEventHandler PropertyChanged;
        private void Notify(string name)
        {
            var handler = PropertyChanged;
            if (handler != null) handler(this, new System.ComponentModel.PropertyChangedEventArgs(name));
        }
    }

    internal sealed class RunningGame
    {
        internal string Id;
        public string Name { get; set; }
        public override string ToString() => Name;
    }
}