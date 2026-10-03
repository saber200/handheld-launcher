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
    internal sealed class RunningGame
    {
        internal string Id;
        public string Name { get; set; }
        public override string ToString() => Name;
    }
}