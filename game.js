(() => {
  const canvas = document.querySelector("#game");
  const ctx = canvas.getContext("2d");
  const scoreEl = document.querySelector("#score");
  const bestEl = document.querySelector("#best");
  const overlay = document.querySelector("#overlay");
  const startBtn = document.querySelector("#start");
  const pauseBtn = document.querySelector("#pause");
  const restartBtn = document.querySelector("#restart");

  const cells = 24;
  const tile = canvas.width / cells;
  const key = "classic-snake-best";
  const initialSnake = [
    { x: 11, y: 12 },
    { x: 10, y: 12 },
    { x: 9, y: 12 }
  ];

  let snake;
  let food;
  let direction;
  let queuedDirection;
  let score;
  let best = Number(localStorage.getItem(key) || 0);
  let running = false;
  let paused = false;
  let gameOver = false;
  let lastMove = 0;
  let moveDelay = 125;
  let touchStart = null;

  bestEl.textContent = best;
  reset();
  requestAnimationFrame(loop);

  startBtn.addEventListener("click", start);
  pauseBtn.addEventListener("click", togglePause);
  restartBtn.addEventListener("click", () => {
    reset();
    start();
  });

  document.addEventListener("keydown", (event) => {
    const next = directionFromKey(event.key);

    if (next) {
      event.preventDefault();
      queueDirection(next);
      if (!running && !gameOver) {
        start();
      }
      return;
    }

    if (event.key === " " || event.key === "Enter") {
      event.preventDefault();
      if (gameOver) {
        reset();
      }
      start();
    }

    if (event.key.toLowerCase() === "p") {
      togglePause();
    }
  });

  canvas.addEventListener("touchstart", (event) => {
    const touch = event.changedTouches[0];
    touchStart = { x: touch.clientX, y: touch.clientY };
  }, { passive: true });

  canvas.addEventListener("touchend", (event) => {
    if (!touchStart) {
      return;
    }

    const touch = event.changedTouches[0];
    const dx = touch.clientX - touchStart.x;
    const dy = touch.clientY - touchStart.y;

    if (Math.max(Math.abs(dx), Math.abs(dy)) > 20) {
      queueDirection(Math.abs(dx) > Math.abs(dy)
        ? { x: Math.sign(dx), y: 0 }
        : { x: 0, y: Math.sign(dy) });
      start();
    }

    touchStart = null;
  }, { passive: true });

  function start() {
    if (gameOver) {
      reset();
    }

    running = true;
    paused = false;
    setOverlay(null);
  }

  function togglePause() {
    if (!running || gameOver) {
      return;
    }

    paused = !paused;
    setOverlay(paused ? "Paused" : null, paused ? "Press P or Pause to continue." : "");
  }

  function reset() {
    snake = initialSnake.map((part) => ({ ...part }));
    direction = { x: 1, y: 0 };
    queuedDirection = direction;
    score = 0;
    moveDelay = 125;
    running = false;
    paused = false;
    gameOver = false;
    scoreEl.textContent = score;
    food = placeFood();
    setOverlay("Press Start", "Use arrow keys, WASD, or swipe.");
    draw();
  }

  function loop(time) {
    if (running && !paused && time - lastMove > moveDelay) {
      step();
      lastMove = time;
    }

    draw();
    requestAnimationFrame(loop);
  }

  function step() {
    direction = queuedDirection;
    const head = {
      x: snake[0].x + direction.x,
      y: snake[0].y + direction.y
    };

    if (head.x < 0 || head.x >= cells || head.y < 0 || head.y >= cells || hitsSnake(head)) {
      finish();
      return;
    }

    snake.unshift(head);

    if (head.x === food.x && head.y === food.y) {
      score += 10;
      scoreEl.textContent = score;
      moveDelay = Math.max(68, moveDelay - 3);
      food = placeFood();
    } else {
      snake.pop();
    }
  }

  function finish() {
    running = false;
    gameOver = true;

    if (score > best) {
      best = score;
      localStorage.setItem(key, best);
      bestEl.textContent = best;
    }

    setOverlay("Game Over", "Press Restart or Enter to play again.");
  }

  function draw() {
    ctx.fillStyle = "#0c1013";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    drawGrid();

    ctx.fillStyle = "#f2c94c";
    roundRect(food.x * tile + 5, food.y * tile + 5, tile - 10, tile - 10, 7);
    ctx.fill();

    snake.forEach((part, index) => {
      ctx.fillStyle = index === 0 ? "#a7f08d" : "#86d672";
      roundRect(part.x * tile + 3, part.y * tile + 3, tile - 6, tile - 6, 6);
      ctx.fill();
    });
  }

  function drawGrid() {
    ctx.strokeStyle = "rgba(255,255,255,0.045)";
    ctx.lineWidth = 1;

    for (let i = 1; i < cells; i += 1) {
      const pos = i * tile;
      ctx.beginPath();
      ctx.moveTo(pos, 0);
      ctx.lineTo(pos, canvas.height);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(0, pos);
      ctx.lineTo(canvas.width, pos);
      ctx.stroke();
    }
  }

  function roundRect(x, y, width, height, radius) {
    ctx.beginPath();
    ctx.moveTo(x + radius, y);
    ctx.arcTo(x + width, y, x + width, y + height, radius);
    ctx.arcTo(x + width, y + height, x, y + height, radius);
    ctx.arcTo(x, y + height, x, y, radius);
    ctx.arcTo(x, y, x + width, y, radius);
    ctx.closePath();
  }

  function placeFood() {
    let candidate;

    do {
      candidate = {
        x: Math.floor(Math.random() * cells),
        y: Math.floor(Math.random() * cells)
      };
    } while (snake.some((part) => part.x === candidate.x && part.y === candidate.y));

    return candidate;
  }

  function hitsSnake(head) {
    return snake.some((part) => part.x === head.x && part.y === head.y);
  }

  function queueDirection(next) {
    if (next.x === -direction.x && next.y === -direction.y) {
      return;
    }

    queuedDirection = next;
  }

  function directionFromKey(keyName) {
    const normalized = keyName.toLowerCase();
    const map = {
      arrowup: { x: 0, y: -1 },
      w: { x: 0, y: -1 },
      arrowdown: { x: 0, y: 1 },
      s: { x: 0, y: 1 },
      arrowleft: { x: -1, y: 0 },
      a: { x: -1, y: 0 },
      arrowright: { x: 1, y: 0 },
      d: { x: 1, y: 0 }
    };

    return map[normalized];
  }

  function setOverlay(title, message = "") {
    if (!title) {
      overlay.classList.add("hidden");
      return;
    }

    overlay.classList.remove("hidden");
    overlay.querySelector("h2").textContent = title;
    overlay.querySelector("p").textContent = message;
  }
})();
