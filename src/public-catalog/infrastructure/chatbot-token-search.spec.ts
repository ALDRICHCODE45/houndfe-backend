import { chatbotSearchTokenSets, foldSearchText } from './chatbot-token-search';

describe('foldSearchText', () => {
  it('lowercases and strips Spanish accents/diaeresis/tilde', () => {
    expect(foldSearchText('ALIMENTÓ Gáto Pingüino Ñandú')).toBe(
      'alimento gato pinguino nandu',
    );
  });
});

describe('chatbotSearchTokenSets', () => {
  it('splits on whitespace and punctuation, folding case and accents', () => {
    expect(chatbotSearchTokenSets(['Croquetas  PEDIGREE'])).toEqual([
      ['croquetas', 'pedigree'],
    ]);
    expect(chatbotSearchTokenSets(['alimentó, GATO!'])).toEqual([
      ['alimento', 'gato'],
    ]);
  });

  it('drops trivial Spanish stopwords', () => {
    expect(chatbotSearchTokenSets(['alimento para gato'])).toEqual([
      ['alimento', 'gato'],
    ]);
    expect(
      chatbotSearchTokenSets(['shampoo de la perra con el collar']),
    ).toEqual([['shampoo', 'perra', 'collar']]);
  });

  it('keeps stopwords when the query would otherwise be empty', () => {
    expect(chatbotSearchTokenSets(['para de'])).toEqual([['para', 'de']]);
  });

  it('deduplicates tokens and keeps digits', () => {
    expect(chatbotSearchTokenSets(['gato gato 375 g'])).toEqual([
      ['gato', '375', 'g'],
    ]);
  });

  it('tokenizes every query variant and removes duplicate variants', () => {
    expect(
      chatbotSearchTokenSets(['ibuprofeno de 400 mg', 'ibuprofeno de 400mg']),
    ).toEqual([
      ['ibuprofeno', '400', 'mg'],
      ['ibuprofeno', '400mg'],
    ]);
    expect(chatbotSearchTokenSets(['x z', 'x  z'])).toEqual([['x', 'z']]);
  });

  it('returns no token sets for blank input', () => {
    expect(chatbotSearchTokenSets(['   ', '...'])).toEqual([]);
  });
});
