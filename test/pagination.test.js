const { parsePagination } = require('../src/utils/paginate');


describe('parsePagination', () => {

  test('page=0 should clamp to 1', () => {

    const result = parsePagination({
      page:'0'
    });

    expect(result.page).toBe(1);

  });


  test('limit=0 should use default limit', () => {

    const result = parsePagination({
      limit:'0'
    });

    expect(result.limit).toBe(20);

  });


  test('limit above max should clamp to 100', () => {

    const result = parsePagination({
      limit:'9999'
    });

    expect(result.limit).toBe(100);

  });


  test('non integer values should use defaults', () => {

    const result = parsePagination({
      page:'abc',
      limit:'hello'
    });


    expect(result.page).toBe(1);
    expect(result.limit).toBe(20);

  });

});