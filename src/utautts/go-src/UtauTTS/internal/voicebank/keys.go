package voicebank

import "sort"

// DefaultSortedKeyは決定的な既定値として辞書順で最初のキーを返す。
func DefaultSortedKey[V any](m map[string]V) string {
	if len(m) == 0 {
		return ""
	}
	keys := make([]string, 0, len(m))
	for key := range m {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	return keys[0]
}
