import { thoughtFor, type GoalId } from '@vana/shared';
import type { AnimalState } from './protocol.js';

/**
 * The thought above the watched animal (spec §10.3). The words come from thoughtFor, the same
 * template the passport uses, over what the server said the planner chose. When the server did
 * not send the planner's state, the bubble stays hidden rather than guessing at a mood.
 */
export class ThoughtBubble {
  constructor(private readonly element: HTMLElement) {}

  show(animal: AnimalState | undefined, screen: { x: number; y: number } | null): void {
    if (animal === undefined || screen === null
      || animal.goalScore === undefined || animal.dependent === undefined) {
      this.element.hidden = true;
      return;
    }
    const thought = thoughtFor({
      state: animal.state,
      currentGoal: animal.currentGoal as GoalId,
      alternativeGoal: (animal.alternativeGoal ?? null) as GoalId | null,
      goalScore: animal.goalScore,
      drives: animal.drives,
      dependent: animal.dependent,
    });
    this.element.hidden = false;
    this.element.classList.toggle('unclear', !thought.confident);
    if (this.element.dataset.text !== thought.text) {
      this.element.dataset.text = thought.text;
      this.element.textContent = thought.text;
      this.element.title = thought.basis.join(' · ');
    }
    this.element.style.transform = `translate(${Math.round(screen.x)}px, ${Math.round(screen.y)}px) translate(-50%, -100%)`;
  }
}
