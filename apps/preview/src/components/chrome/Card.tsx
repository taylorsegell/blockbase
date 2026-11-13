import type { CardProps } from './Card.types';
import { EllipsisIcon, AddIcon } from './Card.parts';
import styles from './Card.module.css';

export function Card({ data, className = '', ...props }: CardProps) {
  const {
    colorClass,
    date,
    title,
    description,
    progressPercent,
    progressValue,
    progressLabel = 'Progress',
    imgSrc1,
    imgAlt1,
    imgSrc2,
    imgAlt2,
    countdownText,
  } = data;

  const colorStyle = (styles as Record<string, string>)[colorClass] || '';

  return (
    <div
      className={`${styles.card} ${colorStyle} card ${colorClass} ${className}`}
      {...props}
    >
      <div className={`${styles.cardHeader} card-header`}>
        <div className="date">{date}</div>
        <button
          type="button"
          aria-label="Course options"
          className={`${styles.btnOptions} btn-options`}
        >
          <EllipsisIcon />
        </button>
      </div>

      <div className={`${styles.cardBody} card-body`}>
        <h3>{title}</h3>
        <p>{description}</p>
        <div className={`${styles.progress} progress`}>
          <span className={styles.progressLabel}>{progressLabel}</span>
          <div className={`${styles.progressTrack} progress-track`}>
            <div
              className={`${styles.progressBar} progress-bar`}
              style={{ width: progressPercent }}
            />
          </div>
          <span className={styles.progressValue}>{progressValue}</span>
        </div>
      </div>

      <div className={`${styles.cardFooter} card-footer`}>
        <ul>
          {imgSrc1 ? (
            <li>
              <img src={imgSrc1} alt={imgAlt1 || 'User avatar'} />
            </li>
          ) : null}
          {imgSrc2 ? (
            <li>
              <img src={imgSrc2} alt={imgAlt2 || 'User avatar'} />
            </li>
          ) : null}
          <li>
            <a
              href="#"
              aria-label="Add collaborator"
              className={`${styles.btnAdd} btn-add`}
              onClick={(event) => event.preventDefault()}
            >
              <AddIcon />
            </a>
          </li>
        </ul>
        <a
          href="#"
          className={`${styles.btnCountdown} btn-countdown`}
          onClick={(event) => event.preventDefault()}
        >
          {countdownText}
        </a>
      </div>
    </div>
  );
}

export default Card;
