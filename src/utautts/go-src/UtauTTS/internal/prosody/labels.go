package prosody

import (
	"bufio"
	"fmt"
	"math"
	"os"
	"regexp"
	"strconv"
	"strings"
)

var htsCurrentPhone = regexp.MustCompile(`-([^+]+)\+`)

var moraNucleus = map[string]bool{
	"a": true, "i": true, "u": true, "e": true, "o": true,
	"A": true, "I": true, "U": true, "E": true, "O": true,
	"N": true, "cl": true,
}

type labeledSegment struct {
	start int
	end   int
	pause bool
}

type phoneSegment struct {
	start int64
	end   int64
	phone string
}

func loadHTSMoraSegments(path string, sampleRate int) ([]labeledSegment, error) {
	file, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer file.Close()
	var phones []phoneSegment
	scanner := bufio.NewScanner(file)
	for scanner.Scan() {
		parts := strings.Fields(scanner.Text())
		if len(parts) != 3 {
			continue
		}
		start, startErr := strconv.ParseInt(parts[0], 10, 64)
		end, endErr := strconv.ParseInt(parts[1], 10, 64)
		match := htsCurrentPhone.FindStringSubmatch(parts[2])
		if startErr != nil || endErr != nil || len(match) != 2 {
			return nil, fmt.Errorf("invalid HTS label line %q", scanner.Text())
		}
		phones = append(phones, phoneSegment{start: start, end: end, phone: match[1]})
	}
	if err := scanner.Err(); err != nil {
		return nil, err
	}
	toFrame := func(value int64) int {
		return int(math.Round(float64(value) * float64(sampleRate) / 1e7))
	}
	var result []labeledSegment
	segmentStart := int64(-1)
	for index, phone := range phones {
		switch {
		case phone.phone == "sil" && index == 0:
			continue
		case phone.phone == "sil" && index == len(phones)-1:
			result = append(result, labeledSegment{start: toFrame(phone.start), end: toFrame(phone.end), pause: true})
			segmentStart = -1
		case phone.phone == "pau":
			result = append(result, labeledSegment{start: toFrame(phone.start), end: toFrame(phone.end), pause: true})
			segmentStart = -1
		default:
			if segmentStart < 0 {
				segmentStart = phone.start
			}
			if moraNucleus[phone.phone] {
				result = append(result, labeledSegment{start: toFrame(segmentStart), end: toFrame(phone.end)})
				segmentStart = -1
			}
		}
	}
	if segmentStart >= 0 {
		return nil, fmt.Errorf("HTS label ends inside a mora")
	}
	return result, nil
}
