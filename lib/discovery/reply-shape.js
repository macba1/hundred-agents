/* ============================================================
   Shape of the agent's reply, enforced in code.

   The "hundred" profile asks for one question per turn. Prompting
   alone does not hold: the model keeps chaining "¿En qué ciudad
   están? ¿Y cuántas personas trabajan ahí?", which makes the
   prospect answer only the last one and quietly loses the first.

   So the rule is enforced deterministically after the model
   answers: keep everything up to and including the FIRST question
   mark, drop the rest. The dropped questions are not lost — the
   agent asks them on the following turns, which is exactly the
   intended rhythm.
   ============================================================ */

/** Keep only the first question of a reply. Text with no question is
    returned untouched (closings, acknowledgements, the final message). */
function keepOneQuestion(reply) {
  const s = String(reply == null ? '' : reply);
  const first = s.indexOf('?');
  if (first === -1) return s;
  const rest = s.slice(first + 1);
  if (!rest.includes('?')) return s; // already a single question
  return s.slice(0, first + 1).trim();
}

module.exports = { keepOneQuestion };
