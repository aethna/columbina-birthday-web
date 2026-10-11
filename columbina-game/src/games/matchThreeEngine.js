export const MATCH_BOARD_SIZE = 8
export const MATCH_GEM_COUNT = 6

const DIRECTIONS = [
  { dx: 1, dy: 0, kind: 'horizontal' },
  { dx: 0, dy: 1, kind: 'vertical' },
]

export function createTile(type) {
  return { id: `${Date.now()}-${Math.random().toString(36).slice(2)}`, type, special: null }
}

function getIndex(x, y) {
  return y * MATCH_BOARD_SIZE + x
}

export function getMatchGroups(board) {
  const runs = []

  for (const direction of DIRECTIONS) {
    for (let y = 0; y < MATCH_BOARD_SIZE; y += 1) {
      for (let x = 0; x < MATCH_BOARD_SIZE; x += 1) {
        const tile = board[getIndex(x, y)]
        if (!tile) continue

        const beforeX = x - direction.dx
        const beforeY = y - direction.dy
        const before = beforeX >= 0 && beforeY >= 0
          ? board[getIndex(beforeX, beforeY)]
          : null
        if (before?.type === tile.type) continue

        const cells = []
        let nextX = x
        let nextY = y
        while (
          nextX < MATCH_BOARD_SIZE && nextY < MATCH_BOARD_SIZE &&
          board[getIndex(nextX, nextY)]?.type === tile.type
        ) {
          cells.push(getIndex(nextX, nextY))
          nextX += direction.dx
          nextY += direction.dy
        }

        if (cells.length >= 3) runs.push({ cells, kind: direction.kind })
      }
    }
  }

  const groups = []
  for (const run of runs) {
    const runCells = new Set(run.cells)
    const overlapping = []
    groups.forEach((group, index) => {
      if (group.runs.some((existing) => existing.cells.some((cell) => runCells.has(cell)))) {
        overlapping.push(index)
      }
    })

    if (overlapping.length === 0) {
      groups.push({ cells: new Set(run.cells), runs: [run] })
      continue
    }

    const first = groups[overlapping[0]]
    run.cells.forEach((cell) => first.cells.add(cell))
    first.runs.push(run)
    for (let i = overlapping.length - 1; i >= 1; i -= 1) {
      const other = groups.splice(overlapping[i], 1)[0]
      other.cells.forEach((cell) => first.cells.add(cell))
      first.runs.push(...other.runs)
    }
  }

  return groups.map((group) => {
    const cells = [...group.cells]
    const hasHorizontal = group.runs.some((run) => run.kind === 'horizontal')
    const hasVertical = group.runs.some((run) => run.kind === 'vertical')
    const longest = [...group.runs].sort((a, b) => b.cells.length - a.cells.length)[0]
    let special = null

    if (hasHorizontal && hasVertical) special = 'area-bomb'
    else if (longest.cells.length >= 5) special = 'color-bomb'
    else if (longest.cells.length === 4) {
      special = longest.kind === 'horizontal' ? 'line-horizontal' : 'line-vertical'
    }

    const intersections = group.runs
      .filter((run) => run.kind === 'horizontal')
      .flatMap((horizontal) => horizontal.cells.filter((cell) => (
        group.runs.some((vertical) => vertical.kind === 'vertical' && vertical.cells.includes(cell))
      )))

    return { cells, runs: group.runs, special, longest, intersections: [...new Set(intersections)] }
  })
}

export function getSpecialAnchor(group, preferredIndex = null) {
  if (preferredIndex != null && group.cells.includes(preferredIndex)) return preferredIndex
  if (group.intersections.length > 0) return group.intersections[0]
  return group.longest.cells[Math.floor(group.longest.cells.length / 2)]
}

export function getSpecialEffect(board, index, colorTarget = null) {
  const tile = board[index]
  if (!tile?.special) return []
  const x = index % MATCH_BOARD_SIZE
  const y = Math.floor(index / MATCH_BOARD_SIZE)
  const cells = []

  if (tile.special === 'line-horizontal') {
    for (let col = 0; col < MATCH_BOARD_SIZE; col += 1) cells.push(getIndex(col, y))
  } else if (tile.special === 'line-vertical') {
    for (let row = 0; row < MATCH_BOARD_SIZE; row += 1) cells.push(getIndex(x, row))
  } else if (tile.special === 'area-bomb') {
    for (let row = Math.max(0, y - 1); row <= Math.min(MATCH_BOARD_SIZE - 1, y + 1); row += 1) {
      for (let col = Math.max(0, x - 1); col <= Math.min(MATCH_BOARD_SIZE - 1, x + 1); col += 1) {
        cells.push(getIndex(col, row))
      }
    }
  } else if (tile.special === 'color-bomb') {
    const target = colorTarget ?? tile.type
    board.forEach((candidate, candidateIndex) => {
      if (candidate?.type === target) cells.push(candidateIndex)
    })
  }

  return cells
}

export function hasLegalMove(board) {
  for (let index = 0; index < board.length; index += 1) {
    const x = index % MATCH_BOARD_SIZE
    const y = Math.floor(index / MATCH_BOARD_SIZE)
    for (const next of [x + 1 < MATCH_BOARD_SIZE ? index + 1 : -1, y + 1 < MATCH_BOARD_SIZE ? index + MATCH_BOARD_SIZE : -1]) {
      if (next < 0) continue
      // Any adjacent special can be activated by swapping, even if no match forms.
      if (board[index]?.special || board[next]?.special) return true
      ;[board[index], board[next]] = [board[next], board[index]]
      const hasMatch = getMatchGroups(board).length > 0
      ;[board[index], board[next]] = [board[next], board[index]]
      if (hasMatch) return true
    }
  }
  return false
}

export function createFreshBoard() {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const board = Array.from({ length: MATCH_BOARD_SIZE * MATCH_BOARD_SIZE }, () => null)
    for (let y = 0; y < MATCH_BOARD_SIZE; y += 1) {
      for (let x = 0; x < MATCH_BOARD_SIZE; x += 1) {
        const blocked = new Set()
        if (x >= 2) {
          const left = board[getIndex(x - 1, y)]
          const leftTwo = board[getIndex(x - 2, y)]
          if (left?.type === leftTwo?.type) blocked.add(left.type)
        }
        if (y >= 2) {
          const above = board[getIndex(x, y - 1)]
          const aboveTwo = board[getIndex(x, y - 2)]
          if (above?.type === aboveTwo?.type) blocked.add(above.type)
        }
        const choices = Array.from({ length: MATCH_GEM_COUNT }, (_, type) => type)
          .filter((type) => !blocked.has(type))
        board[getIndex(x, y)] = createTile(choices[Math.floor(Math.random() * choices.length)])
      }
    }
    if (hasLegalMove(board)) return board
  }

  return Array.from({ length: MATCH_BOARD_SIZE * MATCH_BOARD_SIZE }, (_, index) => (
    createTile((index % MATCH_BOARD_SIZE + Math.floor(index / MATCH_BOARD_SIZE)) % MATCH_GEM_COUNT)
  ))
}
