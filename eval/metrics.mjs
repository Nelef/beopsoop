// 검색 평가 지표. 정답 단위는 "조"(articleKey). search() 가 이미 조 단위로 중복을 없앤 순위를 준다.
export function scoreQuery(rankedKeys, gold, ks = [1, 3, 5, 10]) {
  const g = new Set(gold);
  const out = {};
  for (const k of ks) {
    const top = new Set(rankedKeys.slice(0, k));
    const found = [...g].filter((x) => top.has(x)).length;
    out[`hit@${k}`] = found > 0 ? 1 : 0;        // 정답 조문 중 하나라도 상위 k 안에
    out[`recall@${k}`] = found / g.size;         // 정답 조문 전부 중 몇 %가 상위 k 안에
  }
  const r = rankedKeys.findIndex((x) => g.has(x));
  out.mrr = r < 0 || r >= 10 ? 0 : 1 / (r + 1);  // 첫 정답의 순위 역수(상위 10 까지)
  return out;
}

export function mean(rows) {
  const m = {};
  for (const k of Object.keys(rows[0] ?? {})) m[k] = rows.reduce((a, r) => a + r[k], 0) / rows.length;
  return m;
}
